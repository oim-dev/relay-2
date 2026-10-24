import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createGitSyncClient,
  decodeGitSyncResponse,
  runNativeProcess,
  discoverGitSyncBinary,
  type ProcessResult,
} from "@relay/project-runtime";
import { RuntimeFixture } from "./helpers/runtime-fixture";

const group = "git-sync-implementation/cli-runtime";
const protocolScript = `
if (process.argv.includes('--version')) { console.log('0.0.0'); process.exit(0); }
const request = JSON.parse(await Bun.stdin.text());
if (request.action === 'large') {
  process.stderr.write('diagnostic '.repeat(100000));
  console.log(JSON.stringify({version:1,ok:true,data:{body:'x'.repeat(200000),cwd:process.cwd(),env:process.env.RELAY_TEST_VALUE,request}}));
} else if (request.action === 'error') {
  console.log(JSON.stringify({version:1,ok:false,error:{code:'REMOTE_OFFLINE',message:'Нет сети',exitCode:7,details:{remote:'origin'}}})); process.exitCode=7;
} else if (request.action === 'invalid') { console.log('{bad'); }
else if (request.action === 'hang') { console.log('ready'); setInterval(()=>{},1000); }
else if (request.action === 'invalid-utf8') {
  process.stdout.write(Buffer.concat([Buffer.from('{"version":1,"ok":true,"data":"'), Buffer.from([255]), Buffer.from('"}') ]));
}
else { console.log(JSON.stringify({version:1,ok:true,data:request})); }
`;

describe("Процессный протокол Runtime", () => {
  test("discovery использует переданный PATH, включая Windows Path, без изменения глобальной среды", async () => {
    const fixture = new RuntimeFixture("git-sync-implementation/review-runtime");
    const binDirectory = join(fixture.root, "свой PATH");
    mkdirSync(binDirectory);
    const binary = join(
      binDirectory,
      process.platform === "win32" ? "relay-git-sync.exe" : "relay-git-sync",
    );
    writeFileSync(binary, "fixture");
    chmodSync(binary, 0o700);
    const originalPath = process.env.PATH;
    try {
      const selected = await discoverGitSyncBinary({
        cwd: fixture.cwd,
        env: { [process.platform === "win32" ? "Path" : "PATH"]: binDirectory },
        executablePath: join(fixture.cwd, "relay"),
        version: "0.0.0",
        userHome: fixture.root,
        /**
         * Фиксирует приоритет переданного PATH над dev-discovery, не исполняя текстовый fixture.
         */
        runner: async (command): Promise<ProcessResult> => {
          expect(command.executable).toBe(binary);
          return { exitCode: 0, stdout: "0.0.0\n", stderr: "" };
        },
      });

      expect(selected).toBe(binary);
      expect(process.env.PATH).toBe(originalPath);
    } finally {
      await fixture.dispose();
    }
  });

  test("повреждённый UTF-8 stdout не превращается в успешные данные с символом замены", async () => {
    const fixture = new RuntimeFixture("git-sync-implementation/review-runtime");
    const script = join(fixture.root, "invalid-utf8.ts");
    writeFileSync(script, protocolScript);
    const client = createGitSyncClient({
      cwd: fixture.cwd,
      env: { HOME: fixture.root, USERPROFILE: fixture.root },
      binary: process.execPath,
      executablePath: process.execPath,
      version: "0.0.0",
      userHome: fixture.root,
      /**
       * Только упаковка fixture интерпретируется Bun; stdout декодирует production runner.
       */
      runner: (command): Promise<ProcessResult> =>
        runNativeProcess({ ...command, args: [script, ...command.args] }),
    });
    try {
      await expect(
        client.request({ version: 1, action: "invalid-utf8", options: { cwd: fixture.cwd } }),
      ).rejects.toMatchObject({ code: "GIT_SYNC_PROTOCOL_ERROR" });
    } finally {
      await fixture.dispose();
    }
  });

  test.each([
    { name: "ровно 16 MiB", bytes: 16 * 1024 * 1024, accepted: true },
    { name: "следующий байт", bytes: 16 * 1024 * 1024 + 1, accepted: false },
  ])(
    "бинарная диагностика: $name проверяется до UTF-8 декодирования",
    async ({ bytes, accepted }) => {
      const fixture = new RuntimeFixture("git-sync-implementation/review-runtime");
      const script = join(fixture.root, "binary-output.ts");
      writeFileSync(script, `process.stderr.write(Buffer.alloc(${bytes}, 255));`);
      try {
        const operation = runNativeProcess({
          executable: process.execPath,
          args: [script],
          cwd: fixture.cwd,
          env: { HOME: fixture.root, USERPROFILE: fixture.root },
          timeoutMs: 5000,
        });

        if (accepted) {
          const result = await operation;
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toBe("");
          expect(result.stderr).toBe("\uFFFD".repeat(bytes));
        } else {
          await expect(operation).rejects.toMatchObject({ code: "GIT_SYNC_OUTPUT_LIMIT" });
        }
      } finally {
        await fixture.dispose();
      }
    },
  );

  test("реальный ребёнок читает один JSON stdin, параллельные большие потоки не блокируют запрос", async () => {
    const fixture = new RuntimeFixture(group);
    const script = join(fixture.root, "компонент с пробелами.ts");
    writeFileSync(script, protocolScript);
    const client = createGitSyncClient({
      cwd: fixture.cwd,
      env: {
        ...process.env,
        HOME: fixture.root,
        USERPROFILE: fixture.root,
        RELAY_TEST_VALUE: "точная среда",
      },
      binary: process.execPath,
      executablePath: process.execPath,
      version: "0.0.0",
      userHome: fixture.root,
      /**
       * Интерпретируемый fixture заменяет только executable упаковку; реальные pipes читает production runner.
       */
      runner: (command): Promise<ProcessResult> =>
        runNativeProcess({ ...command, args: [script, ...command.args] }),
    });
    try {
      const request = {
        version: 1 as const,
        action: "large",
        options: { cwd: fixture.cwd, home: fixture.home },
        input: { remote: "Два слова $(literal)", refresh: false },
      };

      const result = await client.request(request);

      expect(result).toEqual({
        body: "x".repeat(200000),
        cwd: fixture.cwd,
        env: "точная среда",
        request,
      });
      await expect(client.request({ ...request, action: "error" })).rejects.toMatchObject({
        code: "REMOTE_OFFLINE",
        exitCode: 7,
        details: { remote: "origin" },
      });
      await expect(client.request({ ...request, action: "invalid" })).rejects.toMatchObject({
        code: "GIT_SYNC_PROTOCOL_ERROR",
      });
    } finally {
      await fixture.dispose();
    }
  });

  test.each([
    { name: "другая версия", response: { version: 2, ok: true, data: null }, exit: 0 },
    { name: "успех при ненулевом exit", response: { version: 1, ok: true, data: null }, exit: 4 },
    {
      name: "ошибка с несовпадающим exit",
      response: { version: 1, ok: false, error: { code: "FAIL", message: "error", exitCode: 4 } },
      exit: 1,
    },
    {
      name: "ошибка без exit",
      response: { version: 1, ok: false, error: { code: "FAIL", message: "error" } },
      exit: 4,
    },
  ])("$name не выдаётся за корректный ответ компонента", ({ response, exit }) => {
    expect(() => decodeGitSyncResponse(JSON.stringify(response), exit, "fixture")).toThrow(
      expect.objectContaining({ code: "GIT_SYNC_PROTOCOL_ERROR" }),
    );
  });

  test("явный override несовместимого binary не обходится кандидатом dev checkout", async () => {
    const fixture = new RuntimeFixture(group);
    try {
      await expect(
        discoverGitSyncBinary({
          cwd: fixture.cwd,
          env: {},
          executablePath: process.execPath,
          binary: process.execPath,
          version: "0.0.0",
          userHome: fixture.root,
          /**
           * Доступный executable сообщает несовместимый выпуск.
           */
          runner: async (): Promise<ProcessResult> => ({
            exitCode: 0,
            stdout: "99.0.0\n",
            stderr: "",
          }),
        }),
      ).rejects.toMatchObject({
        code: "GIT_SYNC_VERSION_MISMATCH",
        details: { expected: "0.0.0" },
      });
    } finally {
      await fixture.dispose();
    }
  });

  test("sibling discovery сохраняет exact executable с Unicode и пробелами", async () => {
    const fixture = new RuntimeFixture(group);
    const sibling = join(fixture.cwd, "Компоненты с пробелами");
    mkdirSync(sibling);
    const binary = join(
      sibling,
      process.platform === "win32" ? "relay-git-sync.exe" : "relay-git-sync",
    );
    writeFileSync(binary, "fixture");
    chmodSync(binary, 0o700);
    try {
      const selected = await discoverGitSyncBinary({
        cwd: fixture.cwd,
        env: {},
        executablePath: join(sibling, "relay"),
        version: "0.0.0",
        userHome: fixture.root,
        /**
         * Проверяет, что discovery запускает выбранный executable отдельным argv.
         */
        runner: async (command): Promise<ProcessResult> => {
          expect(command.executable).toBe(binary);
          expect(command.args).toEqual(["--version"]);
          return { exitCode: 0, stdout: "relay-git-sync 0.0.0\n", stderr: "" };
        },
      });
      expect(selected).toBe(binary);
    } finally {
      await fixture.dispose();
    }
  });

  test("собранная CLI в checkout находит отдельную apps/git-sync/dist без import.meta пути Bun bundle", async () => {
    const fixture = new RuntimeFixture(group);
    const cliDirectory = join(fixture.root, "apps/cli/dist");
    const syncDirectory = join(fixture.root, "apps/git-sync/dist");
    mkdirSync(cliDirectory, { recursive: true });
    mkdirSync(syncDirectory, { recursive: true });
    const cli = join(cliDirectory, process.platform === "win32" ? "relay.exe" : "relay");
    const binary = join(
      syncDirectory,
      process.platform === "win32" ? "relay-git-sync.exe" : "relay-git-sync",
    );
    writeFileSync(cli, "fixture");
    writeFileSync(binary, "fixture");
    chmodSync(cli, 0o700);
    chmodSync(binary, 0o700);
    try {
      const selected = await discoverGitSyncBinary({
        cwd: fixture.cwd,
        env: {},
        executablePath: cli,
        version: "0.0.0",
        userHome: fixture.root,
        /**
         * Только ожидаемая сборка checkout считается совместимой.
         */
        runner: async (command): Promise<ProcessResult> => {
          expect(command.executable).toBe(binary);
          return { exitCode: 0, stdout: "0.0.0\n", stderr: "" };
        },
      });

      expect(selected).toBe(binary);
    } finally {
      await fixture.dispose();
    }
  });

  test("deadline завершает зависший реальный процесс", async () => {
    const fixture = new RuntimeFixture(group);
    const script = join(fixture.root, "hang.ts");
    writeFileSync(script, "setInterval(()=>{},1000);");
    try {
      await expect(
        runNativeProcess({
          executable: process.execPath,
          args: [script],
          cwd: fixture.cwd,
          env: process.env,
          timeoutMs: 150,
        }),
      ).rejects.toMatchObject({ code: "GIT_SYNC_TIMEOUT", exitCode: 124 });
    } finally {
      await fixture.dispose();
    }
  });

  // Linux /proc позволяет проверить завершение и родителя, и собственного потомка без sleep-порогов.
  test.skipIf(process.platform !== "linux")(
    "SIGTERM foreground завершает дерево реальных процессов",
    async () => {
      const fixture = new RuntimeFixture(group);
      const childFile = join(fixture.root, "descendant.ts");
      const parentFile = join(fixture.root, "parent.ts");
      writeFileSync(childFile, "console.log(process.pid); setInterval(()=>{},1000);");
      writeFileSync(
        parentFile,
        `const child=Bun.spawn([process.execPath,${JSON.stringify(childFile)}],{stdout:'pipe',stderr:'inherit'}); const reader=child.stdout.getReader(); const first=await reader.read(); console.log(JSON.stringify({parent:process.pid,child:Number(new TextDecoder().decode(first.value))})); setInterval(()=>{},1000);`,
      );
      const controller = new AbortController();
      let ids: { parent: number; child: number } | undefined;
      try {
        await expect(
          runNativeProcess({
            executable: process.execPath,
            args: [parentFile],
            cwd: fixture.cwd,
            env: process.env,
            timeoutMs: 5000,
            signal: controller.signal,
            /**
             * Готовность обоих процессов служит барьером перед отменой.
             */
            stdout: (text): void => {
              ids = JSON.parse(text);
              controller.abort("SIGTERM");
            },
          }),
        ).rejects.toMatchObject({ code: "GIT_SYNC_CANCELLED", exitCode: 143 });

        expect(ids).toBeDefined();
        if (!ids) {
          throw new Error("Не получена готовность дерева");
        }
        for (const pid of [ids.parent, ids.child]) {
          const stat = resolve("/proc", String(pid), "stat");
          // Сиротский zombie уже не выполняется, его reap принадлежит init контейнера.
          expect(
            !existsSync(stat) || readFileSync(stat, "utf8").split(") ")[1]?.startsWith("Z "),
          ).toBe(true);
        }
      } finally {
        await fixture.dispose();
      }
    },
  );
});
