import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { runNativeProcess } from "@relay/project-runtime";
import type { GitSyncFixtureReady } from "./git-sync-process.types";

const artifacts = resolve(
  import.meta.dir,
  "../../../../.artifacts",
  new Date().toISOString().slice(0, 10),
  "git-sync-implementation/cli-runtime",
);
const relay = resolve(
  import.meta.dir,
  process.platform === "win32" ? "../../dist/relay.exe" : "../../dist/relay",
);
const componentSource = `
import {writeFileSync} from 'node:fs';
if (process.argv.includes('--version')) { console.log('0.0.0'); process.exit(0); }
if (process.argv.includes('--request')) {
  const request = JSON.parse(await Bun.stdin.text());
  if (request.input?.requestId && request.input?.operationId) { console.log(JSON.stringify({version:1,ok:false,error:{code:'DUPLICATE_SUBMIT',message:'Повторный submit вместо wait',exitCode:2}})); process.exitCode=2; }
  else if (request.action === 'request.get') { console.log(JSON.stringify({version:1,ok:true,data:{version:1,requestId:request.input.requestId,instance:null,state:'unknown'}})); }
  else if (request.action === 'now' && request.input?.waitMs === 1) { const id=request.input.requestId ?? request.input.operationId; console.log(JSON.stringify({version:1,ok:false,error:{code:'GIT_SYNC_WAIT_TIMEOUT',message:'Запрос принят',exitCode:4,details:{requestId:id,state:'running'}}})); process.exitCode=4; }
  else if (request.action === 'now') { console.log(JSON.stringify({version:1,ok:false,error:{code:'REMOTE_OFFLINE',message:'Нет сети',exitCode:7,details:{remote:'origin'}}})); process.exitCode=7; }
  else { console.log(JSON.stringify({version:1,ok:true,data:request})); }
} else if (process.argv.includes('supervise')) {
  process.on('SIGTERM',()=>{writeFileSync(process.env.STOP_FILE,'SIGTERM');process.exit(0);});
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){return Response.json({pid:process.pid,lease:process.argv.includes('--parent-lease'),stdinEnded:process.stdin.readableEnded});}});
  if(process.argv.includes('--parent-lease')) {
    process.stdin.on('end',()=>{writeFileSync(process.env.STOP_FILE,JSON.stringify({reason:'stdin-eof',pid:process.pid,cwd:process.cwd(),argv:process.argv.slice(2),executable:process.execPath}));process.exit(0);});
    process.stdin.resume();
  }
  console.log(JSON.stringify({ready:true,pid:process.pid,port:server.port}));
}
`;

/**
 * Читает готовность из настоящего stdout прокси с deadline; не завершает процессы вместо сценария.
 */
function proxyReadiness(child: ChildProcessWithoutNullStreams): Promise<GitSyncFixtureReady> {
  return new Promise((resolveReady, reject) => {
    let text = "";
    const timeout = setTimeout(
      () => reject(new Error("Не получена готовность fixture supervisor")),
      5000,
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      text += chunk;
      if (!text.includes("\n")) {
        return;
      }
      clearTimeout(timeout);
      try {
        const value: unknown = JSON.parse(text.slice(0, text.indexOf("\n")));
        if (
          !value ||
          typeof value !== "object" ||
          !("pid" in value) ||
          typeof value.pid !== "number" ||
          !("port" in value) ||
          typeof value.port !== "number"
        ) {
          throw new Error("Неверная готовность fixture");
        }
        resolveReady({ pid: value.pid, port: value.port });
      } catch (error) {
        reject(error);
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timeout);
      reject(new Error("CLI завершилась до проверки готовности"));
    });
  });
}

/**
 * Ожидает наблюдаемое завершение Linux-процесса; zombie уже не выполняется, его reap принадлежит init.
 * Poll проверяет конкретное условие до deadline и не подменяет его произвольной задержкой.
 */
async function waitForFixtureExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      if (readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.startsWith("Z ")) {
        return;
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    await pause(10);
  }
  throw new Error(`Fixture supervisor ${pid} пережил EOF своего stdin lease`);
}

/**
 * Убирает принадлежащую тесту POSIX-группу, если отказ прокси оставил отдельный supervisor живым.
 */
function terminateFixtureComponent(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      throw error;
    }
  }
}

/**
 * Собирает неизменяемый fixture-компонент рядом с изолированным home; реальные службы не используются.
 */
async function withComponentFixture(
  run: (root: string, binary: string) => Promise<void>,
): Promise<void> {
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "cli-component-"));
  const source = join(root, "fixture.ts");
  const binary = join(root, process.platform === "win32" ? "компонент sync.exe" : "компонент sync");
  writeFileSync(source, componentSource);
  try {
    const build = await runNativeProcess({
      executable: process.execPath,
      args: ["build", "--compile", source, "--outfile", binary],
      cwd: root,
      env: process.env,
      timeoutMs: 30_000,
    });
    expect(build.exitCode).toBe(0);
    await run(root, binary);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("Git Sync в собранной CLI", () => {
  test("timeout выдаёт заранее назначенный ID, recovery/query не добавляют новый submit", async () => {
    await withComponentFixture(async (root, binary) => {
      const env = {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        RELAY_HOME: join(root, "data"),
        RELAY_GIT_SYNC_BIN: binary,
      };
      const first = await runNativeProcess({
        executable: relay,
        args: ["git-sync", "now", "--wait-ms", "1", "--format", "json"],
        cwd: root,
        env,
        timeoutMs: 5000,
      });
      expect(first.exitCode).toBe(4);
      const error = JSON.parse(first.stderr).error;
      expect(error).toMatchObject({ code: "GIT_SYNC_WAIT_TIMEOUT", details: { state: "running" } });
      const id: unknown = error.details.requestId;
      if (typeof id !== "string" || !id) {
        throw new Error("Потерян ID принятого запроса");
      }

      const waited = await runNativeProcess({
        executable: relay,
        args: ["git-sync", "now", "--request-id", id, "--wait-ms", "1", "--format", "json"],
        cwd: root,
        env,
        timeoutMs: 5000,
      });
      const query = await runNativeProcess({
        executable: relay,
        args: ["git-sync", "request", "get", id, "--format", "json"],
        cwd: root,
        env,
        timeoutMs: 5000,
      });

      expect(waited).toMatchObject({ exitCode: 4, stdout: "" });
      expect(JSON.parse(waited.stderr).error).toMatchObject({
        code: "GIT_SYNC_WAIT_TIMEOUT",
        details: { requestId: id, state: "running" },
      });
      expect(query).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(query.stdout)).toEqual({
        ok: true,
        data: { version: 1, requestId: id, instance: null, state: "unknown" },
      });
    });
  }, 40_000);

  test("бинарник передаёт stdin/argv без shell и сохраняет процессную ошибку в JSON stderr", async () => {
    await withComponentFixture(async (root, binary) => {
      const env = {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        RELAY_HOME: join(root, "data"),
        RELAY_GIT_SYNC_BIN: binary,
      };
      const connected = await runNativeProcess({
        executable: relay,
        args: ["git-sync", "connect", "--remote", "путь с пробелом $(literal)", "--format", "json"],
        cwd: root,
        env,
        timeoutMs: 5000,
      });
      const failed = await runNativeProcess({
        executable: relay,
        args: ["git-sync", "now", "--format", "json"],
        cwd: root,
        env,
        timeoutMs: 5000,
      });
      const resumed = await runNativeProcess({
        executable: relay,
        args: [
          "git-sync",
          "restore",
          "--resume",
          "--project-id",
          "saved-project",
          "--format",
          "json",
        ],
        cwd: root,
        env,
        timeoutMs: 5000,
      });
      const rejectedSources = await runNativeProcess({
        executable: relay,
        args: ["git-sync", "restore", "--resume", "--remote", "origin", "--format", "json"],
        cwd: root,
        env: { ...env, RELAY_GIT_SYNC_BIN: join(root, "missing-component") },
        timeoutMs: 5000,
      });
      const resumeHelp = await runNativeProcess({
        executable: relay,
        args: ["git-sync", "restore", "--resume", "--help"],
        cwd: root,
        env: { ...env, RELAY_GIT_SYNC_BIN: join(root, "missing-component") },
        timeoutMs: 5000,
      });

      expect(connected.exitCode).toBe(0);
      expect(connected.stderr).toBe("");
      expect(JSON.parse(connected.stdout)).toEqual({
        ok: true,
        data: {
          version: 1,
          action: "connect",
          options: { cwd: root, home: join(root, "data") },
          input: { remote: "путь с пробелом $(literal)" },
        },
      });
      expect(failed.exitCode).toBe(7);
      expect(failed.stdout).toBe("");
      expect(JSON.parse(failed.stderr)).toEqual({
        ok: false,
        error: { code: "REMOTE_OFFLINE", message: "Нет сети", details: { remote: "origin" } },
      });
      expect(resumed.exitCode).toBe(0);
      expect(resumed.stderr).toBe("");
      expect(JSON.parse(resumed.stdout)).toEqual({
        ok: true,
        data: {
          version: 1,
          action: "restore",
          options: { cwd: root, home: join(root, "data") },
          input: { resume: true, projectId: "saved-project" },
        },
      });
      expect(rejectedSources).toMatchObject({ exitCode: 2, stdout: "" });
      expect(JSON.parse(rejectedSources.stderr).error.code).toBe("INVALID_ARGUMENT");
      expect(resumeHelp.exitCode).toBe(0);
      expect(resumeHelp.stderr).toBe("");
      expect(resumeHelp.stdout).toContain("--project-id");
    });
  }, 40_000);

  // POSIX signal semantics проверяются на Linux. Общий child protocol выше выполняется и на Windows/macOS.
  test.skipIf(process.platform !== "linux")(
    "SIGTERM CLI доставляется отдельной группе foreground supervisor",
    async () => {
      await withComponentFixture(async (root, binary) => {
        const stopFile = join(root, "stopped.txt");
        const controller = new AbortController();
        let componentPid: number | undefined;
        try {
          await expect(
            runNativeProcess({
              executable: relay,
              args: ["git-sync", "supervise"],
              cwd: root,
              env: {
                ...process.env,
                HOME: root,
                RELAY_HOME: join(root, "data"),
                RELAY_GIT_SYNC_BIN: binary,
                STOP_FILE: stopFile,
              },
              timeoutMs: 5000,
              signal: controller.signal,
              /**
               * Отмена посылается только после установки обработчика SIGTERM у компонента.
               */
              stdout: (text): void => {
                const ready: unknown = JSON.parse(text);
                if (
                  !ready ||
                  typeof ready !== "object" ||
                  !("pid" in ready) ||
                  typeof ready.pid !== "number"
                ) {
                  throw new Error("Неверная готовность fixture");
                }
                componentPid = ready.pid;
                controller.abort("SIGTERM");
              },
            }),
          ).rejects.toMatchObject({ code: "GIT_SYNC_CANCELLED", exitCode: 143 });

          expect(readFileSync(stopFile, "utf8")).toBe("SIGTERM");
          expect(componentPid).toBeDefined();
        } finally {
          if (componentPid) {
            terminateFixtureComponent(componentPid);
          }
        }
      });
    },
    40_000,
  );

  test.skipIf(process.platform !== "linux")(
    "SIGKILL только CLI даёт kernel EOF, компонент сам завершает lease и сохраняет файлы",
    async () => {
      await withComponentFixture(async (root, binary) => {
        const home = join(root, "данные supervisor");
        mkdirSync(home);
        const sentinel = join(home, "project-data.txt");
        writeFileSync(sentinel, "Пользовательские данные\r\n  exact  ");
        const binarySize = statSync(binary).size;
        const stopFile = join(root, "eof.json");
        // Нативный spawn без Bun --no-orphans. kill ниже адресует только PID CLI, не её группу/потомков.
        const proxy = spawn(relay, ["git-sync", "supervise", "--home", home], {
          cwd: root,
          env: {
            ...process.env,
            HOME: root,
            USERPROFILE: root,
            RELAY_CONFIG: undefined,
            RELAY_HOME: home,
            RELAY_GIT_SYNC_BIN: binary,
            STOP_FILE: stopFile,
          },
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
        });
        proxy.stdin.end();
        let stderr = "";
        proxy.stderr.setEncoding("utf8");
        proxy.stderr.on("data", (text: string) => {
          stderr += text;
        });
        const exited = new Promise<NodeJS.Signals | null>((resolveExit, reject) => {
          proxy.once("error", reject);
          proxy.once("exit", (_code, signal) => resolveExit(signal));
        });
        let componentPid: number | undefined;
        try {
          const ready = await proxyReadiness(proxy);
          componentPid = ready.pid;
          const health = await fetch(`http://127.0.0.1:${ready.port}/`, {
            signal: AbortSignal.timeout(2000),
          });
          expect(await health.json()).toEqual({ pid: ready.pid, lease: true, stdinEnded: false });
          expect(existsSync(stopFile)).toBe(false);

          expect(proxy.kill("SIGKILL")).toBe(true);
          expect(await exited).toBe("SIGKILL");
          await waitForFixtureExit(ready.pid);

          expect(JSON.parse(readFileSync(stopFile, "utf8"))).toEqual({
            reason: "stdin-eof",
            pid: ready.pid,
            cwd: root,
            argv: ["supervise", "--home", home, "--parent-lease"],
            executable: binary,
          });
          expect(stderr).toBe("");
          expect(readFileSync(sentinel, "utf8")).toBe("Пользовательские данные\r\n  exact  ");
          expect(readFileSync(join(root, "fixture.ts"), "utf8")).toBe(componentSource);
          expect(statSync(binary).size).toBe(binarySize);
        } finally {
          // Уборка выполняется после утверждений/ошибки, поэтому не может замаскировать отсутствие EOF shutdown.
          if (proxy.exitCode === null && proxy.signalCode === null) {
            proxy.kill("SIGKILL");
          }
          await exited;
          if (componentPid) {
            terminateFixtureComponent(componentPid);
          }
        }
      });
    },
    40_000,
  );
});
