import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeExecutableName, runNativeProcess } from "@relay/project-runtime";
import { withRuntimeDirectory } from "../integration/helpers/source-runtime-fixture";

const binary = fileURLToPath(
  new URL(`../../../../apps/cli/dist/${nativeExecutableName("relay")}`, import.meta.url),
);

describe("Приватная SSH-роль поставляемой CLI", () => {
  test("--ssh-profile сохраняет scratch-dir и отдаёт только профиль, очищая пустые probe config", async () => {
    await withRuntimeDirectory(async (root) => {
      const bin = join(root, "bin");
      mkdirSync(bin);
      const scratch = join(root, "служебный профиль с пробелом");
      const log = join(root, "ssh-argv.jsonl");
      const source = join(root, "ssh.ts");
      const ssh = join(bin, nativeExecutableName("ssh"));
      // Подменяется только обнаруживаемый SSH-клиент. CLI, private dispatcher и guardian настоящие.
      writeFileSync(
        source,
        `
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.SSH_PROBE_CALLS, JSON.stringify(args) + "\\n");
if (args[0] === "-V") {
  process.stderr.write("OpenSSH_10.5p1, fixture\\n");
} else if (args[0] === "-G" && args[1] === "-F" && readFileSync(args[2], "utf8") === "") {
  process.stdout.write("probe stdout must not escape\\n");
} else {
  process.exitCode = 97;
}
`,
      );
      const built = await Bun.build({
        entrypoints: [source],
        target: "bun",
        compile: {
          outfile: ssh,
          autoloadDotenv: false,
          autoloadBunfig: false,
          autoloadPackageJson: false,
          autoloadTsconfig: false,
        },
      });
      expect(built.success).toBe(true);

      const result = await runNativeProcess({
        executable: binary,
        args: ["--ssh-profile", scratch],
        cwd: root,
        env: {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          RELAY_HOME: join(root, "relay-home"),
          PATH: bin,
          SSH_PROBE_CALLS: log,
        },
        timeoutMs: 5000,
      });

      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toEqual({
        executable: ssh,
        implementation: "OpenSSH_10.5p1",
        options: ["ForkAfterAuthentication=no", "ControlPersist=no"],
      });
      const calls = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const value: unknown = JSON.parse(line);
          if (
            !Array.isArray(value) ||
            !value.every((arg): arg is string => typeof arg === "string")
          ) {
            throw new Error("Повреждён журнал argv SSH fixture");
          }
          return value;
        });
      expect(calls).toHaveLength(3);
      expect(calls[0]).toEqual(["-V"]);
      for (const [index, option] of ["ForkAfterAuthentication=no", "ControlPersist=no"].entries()) {
        const command = calls[index + 1];
        const configuration = command?.[2];
        if (configuration === undefined) {
          throw new Error("Не передан файл конфигурации SSH probe");
        }
        expect(command).toEqual([
          "-G",
          "-F",
          configuration,
          "-o",
          option,
          "relay-ssh-profile.invalid",
        ]);
        expect(dirname(dirname(configuration))).toBe(scratch);
        expect(existsSync(configuration)).toBe(false);
      }
      expect(readdirSync(scratch)).toEqual([]);
      expect(existsSync(join(root, "relay.config.json"))).toBe(false);
    });
  });
});
