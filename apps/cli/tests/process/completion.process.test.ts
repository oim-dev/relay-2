import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { invokeBinary } from "./cli-process";

const queries = [
  {
    name: "вложенные команды workspace",
    words: ["workspace", "project", ""],
    included: ["add", "list", "remove"],
    excluded: ["document", "task"],
  },
  {
    name: "параметры команды вместе с глобальными",
    words: ["document", "create", "--"],
    included: ["--name", "--body-file", "--actor", "--format"],
    excluded: ["--column"],
  },
  {
    name: "enum после значения позиционного аргумента",
    words: ["task", "move", "TASK-1", "--column", ""],
    included: ["inbox", "done"],
    excluded: ["--column"],
  },
  {
    name: "глобальный enum без чтения явно указанного проекта и stdin",
    words: [
      "--config",
      "/missing-relay.json",
      "document",
      "create",
      "--body-file",
      "-",
      "--format",
      "j",
    ],
    included: ["json"],
    excluded: ["text"],
  },
  {
    name: "значение enum после знака равенства",
    words: ["--format=j"],
    included: ["json"],
    excluded: ["text"],
  },
  {
    name: "завершённый параметр с равенством перед именем команды",
    words: ["--format=json", "docu"],
    included: ["document"],
    excluded: ["task"],
  },
  {
    name: "завершённый параметр с равенством внутри пути команды",
    words: ["document", "--format=json", "create", "--b"],
    included: ["--body", "--body-file"],
    excluded: ["--column"],
  },
  {
    name: "непрозрачное значение с дефисами и несколькими равенствами",
    words: ["--actor=--anything=a=b", "docu"],
    included: ["document"],
    excluded: ["task"],
  },
  {
    name: "завершённый параметр с равенством перед пустым словом",
    words: ["--format=json", ""],
    included: ["document", "task"],
    excluded: ["json"],
  },
] as const;

const scriptMarkers = [
  { shell: "bash", marker: "complete -F __relay_complete relay" },
  { shell: "zsh", marker: "#compdef relay" },
  { shell: "fish", marker: "complete -c relay" },
  { shell: "powershell", marker: "Register-ArgumentCompleter" },
] as const;

const bashValues = [
  { name: "значение через равенство", words: ["relay", "--format=j"], expected: "json\n" },
  { name: "пустое слово", words: ["relay", "--format", ""], expected: "text\njson\n" },
] as const;

const stdoutFailures = [
  { name: "протокол кандидатов", argv: ["complete", "--", "docu"] },
  { name: "нативный генератор скрипта", argv: ["complete", "zsh"] },
] as const;

// Shim задаёт уже выделенные оболочкой слова; проверяется настоящий Bash-транспорт
// и бинарник, без зависимости тестового runner от системного пакета bash-completion.
const bashSetup = `
set -e
_get_comp_words_by_ref() {
    words=("\${COMP_WORDS[@]}")
    cword=$COMP_CWORD
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
}
source <(relay complete bash)
source <(relay complete bash)
`;
const bashAction = `
COMP_WORDS=("$@")
COMP_CWORD=$(($# - 1))
__relay_complete
printf '%s\\n' "\${COMPREPLY[@]}"
`;
const bashRoundTrip = `${bashSetup}\n${bashAction}`;
const bashCaptureRoundTrip = `${bashSetup}
RELAY_BINARY=$(command -v relay)
export RELAY_BINARY
mkdir wrapper
cat > wrapper/relay <<'WRAPPER'
#!/usr/bin/env bash
printf '%s\\0' "$@" > argv.capture
exec "$RELAY_BINARY" "$@"
WRAPPER
chmod +x wrapper/relay
export PATH="$PWD/wrapper:$PATH"
${bashAction}
cat argv.capture
`;

/**
 * Читает значения из публичного протокола плагина после проверки завершающей директивы.
 */
function candidateValues(stdout: string): string[] {
  const lines = stdout.trimEnd().split("\n");
  expect(lines.pop()).toBe(":4");
  return lines.map((line) => line.split("\t")[0] ?? "");
}

describe("Shell completion собранного CLI", () => {
  test.each(queries)(
    "$name: возвращаются подходящие кандидаты",
    async ({ words, included, excluded }) => {
      const result = await invokeBinary(["complete", "--", ...words], { openStdin: true });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.files).toEqual([]);
      const values = candidateValues(result.stdout);
      for (const expected of included) {
        expect(values).toContain(expected);
      }
      for (const unexpected of excluded) {
        expect(values).not.toContain(unexpected);
      }
    },
  );

  test.each(scriptMarkers)(
    "скрипт $shell создаётся без проекта и чтения stdin",
    async ({ shell, marker }) => {
      const result = await invokeBinary(["complete", shell], { openStdin: true });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(marker);
      expect(result.stdout).not.toContain("ИСПОЛЬЗОВАНИЕ:");
      expect(result.files).toEqual([]);
    },
  );

  test("неизвестная оболочка даёт ошибку ввода в выбранном JSON-формате без скрипта", async () => {
    const result = await invokeBinary(["--format", "json", "complete", "unknown"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENT" },
    });
    expect(result.files).toEqual([]);
  });

  test("глобальный параметр перед complete сохраняет протокол запроса", async () => {
    const result = await invokeBinary(["--format", "json", "complete", "--", "--format", "j"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(candidateValues(result.stdout)).toEqual(["json"]);
  });

  test("complete присутствует в русской справке бинарника", async () => {
    const result = await invokeBinary(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("complete");
    expect(result.stdout).toContain("Подключить автодополнение");
  });

  test("закрытый stdout запроса кандидатов не даёт необработанной ошибки", async () => {
    const result = await invokeBinary(["complete", "--", ""], { closeStdout: true });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.files).toEqual([]);
  });

  // /dev/full даёт настоящий отказ записи на Linux; остальные платформы покрыты проверкой EPIPE.
  test.skipIf(!existsSync("/dev/full")).each(stdoutFailures)(
    "$name сообщает об отказе stdout ненулевым кодом и диагностикой",
    async ({ argv }) => {
      const result = await invokeBinary(argv, {
        command: [
          "bash",
          "--noprofile",
          "--norc",
          "-c",
          'exec relay "$@" > /dev/full',
          "stdout-test",
        ],
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("OUTPUT_ERROR");
      expect(result.stderr.match(/OUTPUT_ERROR/g)).toHaveLength(1);
      expect(result.files).toEqual([]);
    },
  );

  test("Bash сохраняет пробелы и буквальную подстановку в аргументе при повторном подключении", async () => {
    const result = await invokeBinary(
      ["relay", "task", "create", "--title", "Два слова $(touch injected)", "--format", "j"],
      { command: ["bash", "--noprofile", "--norc", "-c", bashRoundTrip, "completion-test"] },
    );

    expect(result).toEqual({ exitCode: 0, stdout: "json\n", stderr: "", files: [] });
  });

  test("Bash передаёт точные границы argv через записывающую обёртку настоящего бинарника", async () => {
    const words = [
      "task",
      "create",
      "--title",
      "Два  слова $(touch injected) ' \" *",
      "--format",
      "j",
    ];

    const result = await invokeBinary(["relay", ...words], {
      command: ["bash", "--noprofile", "--norc", "-c", bashCaptureRoundTrip, "argv-test"],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`json\n${["complete", "--", ...words].join("\0")}\0`);
    expect([...result.files].sort()).toEqual(["argv.capture", "wrapper"]);
  });

  test.each(bashValues)(
    "Bash: $name передаётся без повторной фильтрации",
    async ({ words, expected }) => {
      const result = await invokeBinary(words, {
        command: ["bash", "--noprofile", "--norc", "-c", bashRoundTrip, "completion-test"],
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(expected);
      expect(result.files).toEqual([]);
    },
  );
});
