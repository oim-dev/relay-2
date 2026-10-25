import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RelayError } from "@relay/contracts";
import {
  GuardedCommandError,
  runGuardedCommand,
  runNativeProcess,
  type ProcessCommand,
} from "@relay/project-runtime";
import { RuntimeFixture } from "./helpers/runtime-fixture";
import type { NativeTreeReady } from "./helpers/process-guardian-fixture.types";
import { ProcessGuardianBrokerFixture } from "./helpers/process-guardian-broker-fixture";

const group = "git-sync-implementation/process-runtime";
const actor = fileURLToPath(new URL("./helpers/process-guardian-actor.ts", import.meta.url));
const owner = fileURLToPath(new URL("./helpers/process-guardian-owner.ts", import.meta.url));
const forceOwner = fileURLToPath(
  new URL("./helpers/process-guardian-force-owner.ts", import.meta.url),
);
const leaseOwnerCases = [
  { name: "обычный вывод", mode: "normal" },
  { name: "большой вывод и заблокированный IPC-читатель", mode: "block" },
  { name: "большой вывод и незавершённый IPC callback", mode: "hold-output-callback" },
] as const;
const leaseCancellationCases = [
  { name: "SIGTERM", reason: "SIGTERM", marker: "SIGTERM", exitCode: 143 },
  { name: "отмена без причины", reason: undefined, marker: "SIGINT", exitCode: 130 },
] as const;

/**
 * Наблюдает реальное условие до монотонного deadline; завершение fixture не подменяется таймером.
 */
async function observe(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() >= deadline) {
      throw new Error("Процессный барьер не достигнут");
    }
    await Bun.sleep(10);
  }
}

/**
 * Отличает живой Linux-процесс от zombie; на других платформах проверяет существование PID.
 */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
    }
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["ENOENT", "ESRCH"].includes(String(error.code))
    ) {
      return false;
    }
    throw error;
  }
}

/**
 * Ограничивает само ожидание production Promise; внешний timeout не выполняет cleanup вместо runner.
 */
async function bounded<T>(operation: Promise<T>, timeoutMs = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Runner не вернулся после ограниченной остановки")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Собирает явную native-команду с собственным окружением, без запуска проверяемого binary как helper.
 */
function command(fixture: RuntimeFixture, role = "orphan"): ProcessCommand {
  return {
    executable: process.execPath,
    args: [actor, role, fixture.root],
    cwd: fixture.cwd,
    env: { ...process.env, HOME: fixture.root, USERPROFILE: fixture.root },
    timeoutMs: 5000,
  };
}

/**
 * Читает барьер после его атомарной публикации и проверяет точные принадлежащие fixture PID.
 */
async function treeReady(root: string): Promise<NativeTreeReady> {
  const path = join(root, "tree.ready");
  await observe(() => existsSync(path));
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    value === null ||
    typeof value !== "object" ||
    !("parent" in value) ||
    typeof value.parent !== "number" ||
    !("branch" in value) ||
    typeof value.branch !== "number" ||
    !("leaf" in value) ||
    typeof value.leaf !== "number" ||
    ![value.parent, value.branch, value.leaf].every((pid) => Number.isSafeInteger(pid) && pid > 1)
  ) {
    throw new Error("Повреждён PID-барьер fixture");
  }
  return { parent: value.parent, branch: value.branch, leaf: value.leaf };
}

/**
 * Аварийная очистка точных PID выполняется только после утверждений; имена процессов не сканируются.
 */
async function disposeFixture(fixture: RuntimeFixture): Promise<void> {
  writeFileSync(join(fixture.root, "stop"), "stop");
  if (existsSync(join(fixture.root, "tree.ready"))) {
    const tree = await treeReady(fixture.root);
    for (const pid of [tree.leaf, tree.branch, tree.parent]) {
      if (running(pid)) {
        process.kill(pid, "SIGKILL");
      }
    }
  }
  if (existsSync(join(fixture.root, "leaf.pid"))) {
    const pid: unknown = JSON.parse(readFileSync(join(fixture.root, "leaf.pid"), "utf8"));
    if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1) {
      await observe(() => !running(pid));
    }
  }
  await fixture.dispose();
}

describe("Общее владение native-процессами Runtime", () => {
  test("отсутствующий executable сохраняет ENOENT и command-spawn без раскрытия параметров", async () => {
    const fixture = new RuntimeFixture(`${group}/spawn-diagnostics`);
    const secret = "fixture-private-token-413";
    try {
      const failure: unknown = await runNativeProcess({
        executable: join(fixture.root, `missing-${secret}`),
        args: ["--credential", secret],
        cwd: fixture.cwd,
        env: { HOME: fixture.root, USERPROFILE: fixture.root, PRIVATE_TOKEN: secret },
        timeoutMs: 5000,
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(RelayError);
      if (!(failure instanceof RelayError)) {
        throw new Error("Ожидался native отказ Runtime");
      }
      expect(failure.code).toBe("GIT_SYNC_SPAWN_FAILED");
      expect(failure.exitCode).toBe(1);
      expect(failure.details).toEqual({ stderr: "", stage: "command-spawn", systemCode: "ENOENT" });
      expect(failure.cause).toBeInstanceOf(GuardedCommandError);
      if (!(failure.cause instanceof GuardedCommandError)) {
        throw new Error("Утрачена причина guardian");
      }
      expect(failure.cause).toMatchObject({
        reason: "spawn",
        stage: "command-spawn",
        systemCode: "ENOENT",
      });
      expect(failure.cause.cause).toEqual({ stage: "command-spawn", systemCode: "ENOENT" });
      expect(
        JSON.stringify({
          message: failure.message,
          details: failure.details,
          guardianMessage: failure.cause.message,
          nativeCause: failure.cause.cause,
        }),
      ).not.toContain(secret);
    } finally {
      await fixture.dispose();
    }
  });

  test.each([
    {
      name: "нарушение отдельного лимита stdout",
      output: "MTIzNDU=",
      perStream: 4,
      streaming: false,
    },
    {
      name: "подмена streaming вывода конечным буфером",
      output: "YQ==",
      perStream: 8,
      streaming: true,
    },
  ])(
    "$name в ответе helper не превращается в успешный результат",
    async ({ output, perStream, streaming }) => {
      const fixture = new RuntimeFixture(group);
      const helper = join(fixture.root, "invalid-helper.ts");
      writeFileSync(
        helper,
        `process.stdin.resume();
process.send({version:1,kind:'ready'},()=>{
const body=Buffer.from(JSON.stringify({version:1,kind:'result',code:0,stdout:${JSON.stringify(output)},stderr:''}));
const header=Buffer.alloc(4);header.writeUInt32BE(body.length);
process.stdout.write(Buffer.concat([header,body]),()=>process.exit(0));});`,
      );
      try {
        const operation = runGuardedCommand({
          component: [process.execPath, helper],
          argv: [process.execPath, "--version"],
          cwd: fixture.cwd,
          env: {},
          timeoutMs: 1000,
          maxOutputBytes: 8,
          maxOutputBytesPerStream: perStream,
          ...(streaming
            ? {
                /**
                 * Этот получатель не должен получать данные из конечного capture-frame.
                 */
                stdout(): void {
                  throw new Error("Неожиданный streaming chunk fixture");
                },
              }
            : {}),
        });

        await expect(operation).rejects.toMatchObject({ reason: "protocol" });
      } finally {
        await fixture.dispose();
      }
    },
  );

  test.skipIf(process.platform === "darwin")(
    "ранний exit очищает detached-grandchild с inherited stdout без ожидания его добровольного EOF",
    async () => {
      const fixture = new RuntimeFixture(group);
      const operation = runNativeProcess(command(fixture));
      try {
        const tree = await treeReady(fixture.root);
        expect([tree.parent, tree.branch, tree.leaf].every(running)).toBe(true);

        writeFileSync(join(fixture.root, "exit-parent"), "exit");
        const result = await bounded(operation);

        expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
        expect(running(tree.parent)).toBe(false);
        expect(running(tree.branch)).toBe(false);
        expect(running(tree.leaf)).toBe(false);
      } finally {
        await disposeFixture(fixture);
      }
    },
  );

  test.skipIf(process.platform === "darwin")(
    "deadline завершает живую команду и detached-grandchild, который удерживает stdout",
    async () => {
      const fixture = new RuntimeFixture(group);
      const operation = runNativeProcess({
        ...command(fixture),
        timeoutMs: 800,
      });
      const outcome = operation.catch((error: unknown) => error);
      try {
        const tree = await treeReady(fixture.root);
        expect([tree.parent, tree.branch, tree.leaf].every(running)).toBe(true);

        const failure = await bounded(outcome);

        expect(failure).toMatchObject({ code: "GIT_SYNC_TIMEOUT", exitCode: 124 });
        expect(running(tree.branch)).toBe(false);
        expect(running(tree.leaf)).toBe(false);
      } finally {
        await disposeFixture(fixture);
      }
    },
    8000,
  );

  test.skipIf(process.platform === "darwin")(
    "отмена завершает команду и удерживающих pipes потомков через тот же контейнер",
    async () => {
      const fixture = new RuntimeFixture(group);
      const controller = new AbortController();
      const operation = runNativeProcess({
        ...command(fixture),
        signal: controller.signal,
      });
      const outcome = operation.catch((error: unknown) => error);
      try {
        const tree = await treeReady(fixture.root);

        controller.abort("SIGTERM");
        const failure = await bounded(outcome);

        expect(failure).toMatchObject({ code: "GIT_SYNC_CANCELLED", exitCode: 143 });
        expect(running(tree.branch)).toBe(false);
        expect(running(tree.leaf)).toBe(false);
      } finally {
        await disposeFixture(fixture);
      }
    },
  );

  test.skipIf(process.platform === "darwin")(
    "invalid UTF-8 после exit не освобождает escaped-потомков и не ждёт бесконечный drain",
    async () => {
      const fixture = new RuntimeFixture(group);
      const operation = runNativeProcess({
        ...command(fixture),
        strictStdout: true,
      });
      const outcome = operation.catch((error: unknown) => error);
      try {
        const tree = await treeReady(fixture.root);
        writeFileSync(join(fixture.root, "exit-parent"), "invalid-exit");
        const failure = await bounded(outcome);

        expect(failure).toMatchObject({ code: "GIT_SYNC_PROTOCOL_ERROR" });
        expect(running(tree.branch)).toBe(false);
        expect(running(tree.leaf)).toBe(false);
      } finally {
        await disposeFixture(fixture);
      }
    },
  );

  // Внешний watchdog оставляет время для cleanup после отказа пятисекундного барьера сценария.
  test("постоянный worker независимого broker переживает строгую очистку короткого запроса", async () => {
    const fixture = new ProcessGuardianBrokerFixture(
      "git-sync-finalization/windows-broker-fixture",
    );
    const cancellation = new AbortController();
    const failures: unknown[] = [];
    let operation: ReturnType<typeof runNativeProcess> | undefined;
    try {
      const endpoint = fixture.start(actor);
      operation = runNativeProcess({
        ...command(fixture, "broker-client"),
        args: [actor, "broker-client", fixture.root, endpoint],
        input: '{"action":"worker.start"}',
        signal: cancellation.signal,
      });
      const result = await bounded(operation);

      expect(result).toEqual({ exitCode: 0, stdout: "broker-accepted\n", stderr: "" });
      expect(fixture.requests).toEqual(['{"action":"worker.start"}']);
      writeFileSync(join(fixture.root, "ping"), "ping");
      await observe(() => existsSync(join(fixture.root, "pong")));
      const pid = Number(readFileSync(join(fixture.root, "pong"), "utf8"));
      const workerPid = fixture.workerPid;
      if (workerPid === undefined) {
        throw new Error("Broker не создал собственного worker");
      }
      expect(pid).toBe(workerPid);
      expect(running(pid)).toBe(true);
    } catch (error) {
      failures.push(error);
    } finally {
      cancellation.abort("SIGTERM");
      // При срабатывании bounded короткий запрос всё ещё принадлежит тесту.
      try {
        await operation;
      } catch (error) {
        if (!failures.includes(error)) {
          failures.push(error);
        }
      }
      try {
        await fixture.dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Ошибки сценария и очистки независимого broker");
    }
  }, 20_000);

  for (const scenario of leaseOwnerCases) {
    test(`SIGKILL только владельца даёт stdin-eof target: ${scenario.name}`, async () => {
      const fixture = new RuntimeFixture(group);
      const child = spawn(process.execPath, [owner, fixture.root, scenario.mode], {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      child.stdout.resume();
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(0, 4096);
      });
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      const failures: unknown[] = [];
      let pid: number | undefined;
      // Барьеры отказывают раньше внешнего watchdog теста, оставляя время для finally.
      const deadline = performance.now() + 4000;
      /**
       * При зависании сохраняет фазу, наблюдаемые маркеры и ограниченную диагностику fixture.
       */
      async function leaseBarrier(phase: string, condition: () => boolean): Promise<void> {
        try {
          await observe(condition, Math.max(0, deadline - performance.now()));
        } catch (cause) {
          const markers = [
            "lease.ready",
            "owner-blocked",
            "flood-started",
            "flood-flushed",
            "output-callback-pending",
            "lease-stop-requested",
            "stopped.json",
          ];
          throw new Error(
            `Барьер lease ${phase}: ${JSON.stringify({
              markers: markers.filter((marker) => existsSync(join(fixture.root, marker))),
              ownerExit: child.exitCode,
              ownerSignal: child.signalCode,
              targetRunning: pid === undefined ? null : running(pid),
              stderr,
            })}`,
            { cause },
          );
        }
      }
      try {
        await leaseBarrier("target-ready", () => existsSync(join(fixture.root, "lease.ready")));
        pid = Number(readFileSync(join(fixture.root, "lease.ready"), "utf8"));
        if (scenario.mode !== "normal") {
          await leaseBarrier("owner-blocked", () =>
            existsSync(join(fixture.root, "owner-blocked")),
          );
          await leaseBarrier("flood-started", () =>
            existsSync(join(fixture.root, "flood-started")),
          );
        }
        if (scenario.mode === "hold-output-callback") {
          await leaseBarrier("output-callback-pending", () =>
            existsSync(join(fixture.root, "output-callback-pending")),
          );
          expect(existsSync(join(fixture.root, "flood-flushed"))).toBe(false);
        }
        expect(running(pid)).toBe(true);

        child.kill("SIGKILL");
        await exited;
        await leaseBarrier("target-stopped", () => existsSync(join(fixture.root, "stopped.json")));
        await leaseBarrier("target-exited", () => pid !== undefined && !running(pid));

        expect(JSON.parse(readFileSync(join(fixture.root, "stopped.json"), "utf8"))).toEqual({
          reason: "stdin-eof",
          pid,
        });
        if (scenario.mode !== "normal") {
          expect(existsSync(join(fixture.root, "flood-flushed"))).toBe(true);
        }
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          child.kill("SIGKILL");
          await exited;
          if (pid && running(pid)) {
            process.kill(pid, "SIGKILL");
          }
          await fixture.dispose();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "Ошибки stdin lease и очистки процессной fixture");
      }
    });
  }

  for (const scenario of leaseCancellationCases) {
    test.skipIf(process.platform === "win32")(
      `${scenario.name} для stdinLease доставляет ожидаемый сигнал вместо stdin-eof`,
      async () => {
        const fixture = new RuntimeFixture(group);
        const controller = new AbortController();
        const operation = runNativeProcess({
          ...command(fixture, "lease"),
          timeoutMs: null,
          stdinLease: true,
          signal: controller.signal,
        });
        const outcome = operation.catch((error: unknown) => error);
        let pid: number | undefined;
        try {
          await observe(() => existsSync(join(fixture.root, "lease.ready")));
          pid = Number(readFileSync(join(fixture.root, "lease.ready"), "utf8"));

          controller.abort(scenario.reason);
          const failure = await bounded(outcome);

          expect(failure).toMatchObject({
            code: "GIT_SYNC_CANCELLED",
            exitCode: scenario.exitCode,
          });
          expect(JSON.parse(readFileSync(join(fixture.root, "stopped.json"), "utf8"))).toEqual({
            reason: scenario.marker,
            pid,
          });
          expect(running(pid)).toBe(false);
        } finally {
          controller.abort("SIGTERM");
          if (pid && running(pid)) {
            process.kill(pid, "SIGKILL");
          }
          await fixture.dispose();
        }
      },
    );
  }

  test("отказ helper с унаследованными pipes тоже имеет ограниченный drain", async () => {
    const fixture = new RuntimeFixture(group);
    const operation = runGuardedCommand({
      component: [process.execPath, actor, "broken-helper", fixture.root],
      argv: [process.execPath, "--version"],
      cwd: fixture.cwd,
      env: process.env,
      timeoutMs: 1000,
      maxOutputBytes: 1024,
    });
    const outcome = operation.catch((error: unknown) => error);
    try {
      const tree = await treeReady(fixture.root);
      writeFileSync(join(fixture.root, "exit-parent"), "exit");
      await observe(() => !running(tree.parent));

      const failure = await bounded(outcome, 7000);

      expect(failure).toMatchObject({ reason: "guardian" });
      // Этот намеренно неверный helper не создавал контейнер; fixture убирает его точные PID после assert.
    } finally {
      await disposeFixture(fixture);
    }
  }, 9000);

  test("поздний exit принудительно остановленного helper не удерживает caller новым drain-таймером", async () => {
    const fixture = new RuntimeFixture(group);
    const helperPidFile = join(fixture.root, "helper.pid");
    const completed = join(fixture.root, "completed");
    // Только helper намеренно не исполняет stop. Caller после отказа ещё обслуживает свой event loop.
    const child = spawn(process.execPath, [forceOwner, fixture.root], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.resume();
    const stderr = new Response(child.stderr).text();
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    try {
      await observe(() => existsSync(completed), 8000);

      const code = await bounded(exited, 1000);

      expect(code).toBe(0);
      expect(await stderr).toBe("");
      expect(readFileSync(completed, "utf8")).toBe("cleanup");
    } finally {
      child.kill("SIGKILL");
      await exited;
      if (existsSync(helperPidFile)) {
        const pid = Number(readFileSync(helperPidFile, "utf8"));
        if (Number.isSafeInteger(pid) && pid > 1 && running(pid)) {
          process.kill(pid, "SIGKILL");
        }
      }
      await fixture.dispose();
    }
  }, 10_000);

  test("compiled embedding требует явный доверенный component, после его передачи private роль работает", async () => {
    const fixture = new RuntimeFixture(group);
    const source = join(fixture.root, "embedding.ts");
    const binary = join(fixture.root, process.platform === "win32" ? "embedding.exe" : "embedding");
    const marker = join(fixture.root, "target-ran");
    const runtimeEntry = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
    writeFileSync(
      source,
      `import {runNativeProcess,runGuardianEntry} from ${JSON.stringify(runtimeEntry)};
import {writeFileSync} from 'node:fs';
if(process.argv.includes('--guarded-command')){process.exit(await runGuardianEntry());}
if(process.argv.includes('--target')){writeFileSync(${JSON.stringify(marker)},'target');process.stdout.write('trusted');process.exit(0);}
try { const result=await runNativeProcess({executable:process.execPath,args:['--target'],cwd:process.cwd(),env:{},timeoutMs:5000,...(process.argv.includes('--explicit')?{guardianComponent:[process.execPath]}:{})});process.stdout.write(result.stdout); }
catch(error){process.stdout.write(error.code??'unexpected');}`,
    );
    try {
      expect(
        (
          await runNativeProcess({
            ...command(fixture),
            args: ["build", "--compile", source, "--outfile", binary],
          })
        ).exitCode,
      ).toBe(0);

      const missing = await runNativeProcess({ ...command(fixture), executable: binary, args: [] });
      expect(missing.stdout).toBe("GIT_SYNC_GUARDIAN_REQUIRED");
      expect(existsSync(marker)).toBe(false);
      const explicit = await runNativeProcess({
        ...command(fixture),
        executable: binary,
        args: ["--explicit"],
      });

      expect(explicit).toEqual({ exitCode: 0, stdout: "trusted", stderr: "" });
      expect(readFileSync(marker, "utf8")).toBe("target");
    } finally {
      await fixture.dispose();
    }
  }, 15_000);
});
