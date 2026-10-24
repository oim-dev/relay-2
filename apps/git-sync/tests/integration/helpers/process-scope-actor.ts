import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RelayError } from "@relay/contracts";
import { runGuardianEntry } from "@relay/project-runtime";
import { runProcess } from "../../../src/transport/process";
import type { ProcessResult } from "../../../src/transport/process.types";
import { withGitProcessRuntime } from "../../../src/transport/process-runtime";

/**
 * Ожидает явный файловый барьер только этого fixture с конечным deadline.
 */
async function until(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!condition()) {
    if (performance.now() >= deadline) {
      throw new Error("Не достигнут барьер process scope");
    }
    await Bun.sleep(5);
  }
}

/**
 * Запускает тот же actor в source и standalone форме без предположения о process.execPath shim.
 */
function selfArguments(args: readonly string[]): string[] {
  return Bun.isStandaloneExecutable ? [...args] : [import.meta.path, ...args];
}

/**
 * Доказывает scope lifetime на живом заблокированном target, затем проверяет late bound call.
 */
async function inspectScope(root: string, observed: boolean): Promise<void> {
  let pending: Promise<ProcessResult> | undefined;
  let late: (() => Promise<ProcessResult>) | undefined;
  let settled = false;
  const helper = join(root, "helper");
  const scope = withGitProcessRuntime(
    async () => {
      pending = runProcess({
        executable: process.execPath,
        args: selfArguments(["--target", root]),
        cwd: root,
        timeoutMs: 5000,
      });
      late = AsyncLocalStorage.bind(() =>
        runProcess({
          executable: process.execPath,
          args: selfArguments(["--late", root]),
          cwd: root,
          timeoutMs: 5000,
        }),
      );
    },
    helper,
    observed ? () => {} : undefined,
  ).finally(() => {
    settled = true;
  });
  try {
    await until(() => existsSync(join(root, "target-started")));
    const pid = Number(readFileSync(join(root, "target-started"), "utf8"));
    process.kill(pid, 0);
    const returnedWhileTargetLive = settled;
    writeFileSync(join(root, "release"), "exit");
    await scope;
    if (pending === undefined || late === undefined) {
      throw new Error("Scope callback не зарегистрировал работу");
    }
    const result = await pending;
    const lateResult = await late().then(
      () => "launched",
      (error: unknown) => (error instanceof RelayError ? error.code : "unexpected"),
    );
    console.log(
      JSON.stringify({
        standalone: Bun.isStandaloneExecutable,
        observed,
        targetWasLive: true,
        returnedWhileTargetLive,
        code: result.exitCode,
        stdout: result.stdout.toString(),
        lateResult,
        lateMarker: existsSync(join(root, "late-ran")),
        helperRemoved: !existsSync(helper),
      }),
    );
  } finally {
    writeFileSync(join(root, "release"), "exit");
    await scope.catch(() => {});
    await pending?.catch(() => {});
  }
}

const [role, root, mode] = process.argv.slice(2);
if (role === "--guarded-command") {
  process.exitCode = await runGuardianEntry();
} else if (root === undefined) {
  throw new Error("Не передан собственный каталог actor");
} else if (role === "--target") {
  writeFileSync(join(root, "target-started"), String(process.pid));
  await until(() => existsSync(join(root, "release")));
  process.stdout.write("target-done");
} else if (role === "--late") {
  writeFileSync(join(root, "late-ran"), "launched");
} else if (role === "--inspect") {
  await inspectScope(root, mode === "observed");
} else {
  throw new Error("Неизвестная роль actor");
}
