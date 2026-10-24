import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Публикует барьер атомарно, чтобы наблюдатель никогда не читал половину JSON.
 */
function publish(path: string, value: unknown): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(value));
  renameSync(`${path}.tmp`, path);
}

/**
 * Ждёт явный файловый барьер с монотонным deadline, не заменяя готовность фиксированной паузой.
 */
async function waitForFile(path: string): Promise<void> {
  const deadline = performance.now() + 30_000;
  while (!existsSync(path)) {
    if (performance.now() >= deadline) {
      process.exit(99);
    }
    await Bun.sleep(10);
  }
}

/**
 * Запускает настоящий detached-потомок; родительский тест владеет его PID и контрольными файлами.
 */
function launch(role: string, root: string): void {
  const child = spawn(process.execPath, [import.meta.path, role, root], {
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.unref();
}

/**
 * Выполняет один процессный сценарий: живой lease либо дерево, сохраняющее output после exit родителя.
 */
async function runActor(): Promise<void> {
  const [role, rootArgument] = process.argv.slice(2);
  if (!rootArgument) {
    throw new Error("Не передан каталог процессного сценария");
  }
  const root = rootArgument;
  if (role === "lease" || role === "lease-flood") {
    /**
     * Фиксирует первичную причину остановки до реального завершения fixture.
     */
    function finish(reason: string): void {
      publish(join(root, "stopped.json"), { reason, pid: process.pid });
      process.exit(0);
    }
    process.on("SIGTERM", () => finish("SIGTERM"));
    process.on("SIGINT", () => finish("SIGINT"));
    process.stdin.once("end", () => finish("stdin-eof"));
    process.stdin.resume();
    publish(join(root, "lease.ready"), process.pid);
    process.stdout.write("lease-ready\n");
    if (role === "lease-flood") {
      process.stdout.write(Buffer.alloc(2 * 1024 * 1024, 65));
    }
    setTimeout(() => process.exit(99), 30_000);
    return;
  }
  if (role === "leaf" || role === "persistent") {
    publish(join(root, "leaf.pid"), process.pid);
    const deadline = performance.now() + 30_000;
    while (!existsSync(join(root, "stop"))) {
      if (existsSync(join(root, "ping"))) {
        publish(join(root, "pong"), process.pid);
      }
      if (performance.now() >= deadline) {
        process.exit(99);
      }
      await Bun.sleep(10);
    }
    return;
  }
  if (role === "branch") {
    launch("leaf", root);
    await waitForFile(join(root, "leaf.pid"));
    publish(join(root, "branch.pid"), process.pid);
    await waitForFile(join(root, "stop"));
    return;
  }
  if (role === "broker-client") {
    const input = await Bun.stdin.text();
    const endpoint = process.argv[4];
    if (!endpoint) {
      throw new Error("Не передан endpoint независимого broker");
    }
    const response = await fetch(endpoint, {
      method: "POST",
      body: input,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      process.exit(3);
    }
    process.stdout.write("broker-accepted\n");
    return;
  }
  if (role === "orphan" || role === "broken-helper") {
    launch("branch", root);
    await waitForFile(join(root, "branch.pid"));
    publish(join(root, "tree.ready"), {
      parent: process.pid,
      branch: JSON.parse(readFileSync(join(root, "branch.pid"), "utf8")),
      leaf: JSON.parse(readFileSync(join(root, "leaf.pid"), "utf8")),
    });
    await waitForFile(join(root, "exit-parent"));
    if (readFileSync(join(root, "exit-parent"), "utf8") === "invalid-exit") {
      process.stdout.write(Buffer.from([255]), () => process.exit(0));
      return;
    }
    process.exit(0);
  }
  throw new Error("Неизвестная роль процессного сценария");
}

await runActor();
