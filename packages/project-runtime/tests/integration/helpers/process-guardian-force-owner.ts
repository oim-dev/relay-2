import { GuardedCommandError, runGuardedCommand } from "@relay/project-runtime";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Имитирует доверенную роль с отказавшим управлением: готовность есть, но stop и EOF игнорируются.
 * Fixture публикует собственный PID для аварийной уборки; target вообще не запускается.
 */
function runUncooperativeHelper(root: string): void {
  process.stdin.resume();
  process.on("message", () => {});
  writeFileSync(join(root, "helper.pid"), String(process.pid));
  process.send?.({ version: 1, kind: "ready" }, () => {
    process.send?.({
      version: 1,
      kind: "output",
      stream: "stdout",
      data: Buffer.from(String(process.pid)).toString("base64"),
    });
  });
  setTimeout(() => process.exit(99), 30_000);
}

/**
 * Держит caller активным до наблюдаемого выхода его helper после возвращённого отказа.
 * Это позволяет доставить поздний exit ChildProcess, не маскируя утечку timer выходом caller.
 */
async function waitForHelperExit(pid: number): Promise<void> {
  const deadline = performance.now() + 5000;
  while (true) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") {
        return;
      }
      throw error;
    }
    if (performance.now() >= deadline) {
      throw new Error("Helper не завершился после принудительной остановки");
    }
    await Bun.sleep(5);
  }
}

/**
 * Дожидается production force deadline, затем проверяет возврат cleanup и завершение helper.
 * Caller не вызывает process.exit: лишние ref-таймеры должны стать видны родительскому тесту.
 */
async function runOwner(root: string): Promise<void> {
  const cancellation = new AbortController();
  let helperPid: number | undefined;
  const failure: unknown = await runGuardedCommand({
    component: [process.execPath, import.meta.path, root],
    argv: [process.execPath, "--version"],
    cwd: root,
    env: {},
    timeoutMs: null,
    stdinLease: true,
    maxOutputBytes: 0,
    signal: cancellation.signal,
    /**
     * Отменяет уже готовую роль, которая намеренно не исполняет управляющие сообщения.
     */
    stdout(chunk): void {
      helperPid = Number(Buffer.from(chunk).toString());
      cancellation.abort("SIGTERM");
    },
  }).catch((error: unknown) => error);
  if (!(failure instanceof GuardedCommandError) || failure.reason !== "cleanup") {
    throw new Error("Неверный отказ неисправного helper", { cause: failure });
  }
  if (helperPid === undefined || !Number.isSafeInteger(helperPid) || helperPid <= 1) {
    throw new Error("Helper не сообщил собственный PID");
  }
  writeFileSync(join(root, "completed"), failure.reason);
  await waitForHelperExit(helperPid);
}

const root = process.argv[2];
if (!root) {
  throw new Error("Не передан каталог владельца неисправного helper");
}
if (process.argv[3] === "--guarded-command") {
  runUncooperativeHelper(root);
} else {
  await runOwner(root);
}
