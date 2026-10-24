import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Ждёт опубликованный контрольный файл; абсолютный deadline предотвращает забытый fixture.
 */
async function waitFile(path: string): Promise<void> {
  const deadline = performance.now() + 30_000;
  while (!existsSync(path)) {
    if (performance.now() >= deadline) {
      process.exit(99);
    }
    await Bun.sleep(10);
  }
}

/**
 * Публикует PID-барьер атомарным rename, исключая чтение частично записанного JSON.
 */
function publish(path: string, value: unknown): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(value));
  renameSync(`${path}.tmp`, path);
}

/**
 * Запускает потомка с отсоединёнными stdio; он не удерживает результат родителя через pipes.
 */
function descendant(role: string, root: string, detached: boolean): void {
  const child = spawn(
    process.execPath,
    [import.meta.path, detached ? `${role}-detached` : role, root],
    {
      stdio: "ignore",
      env: process.env,
      detached,
    },
  );
  child.once("spawn", () => {
    publish(join(root, `${role}.spawned`), { pid: child.pid, parent: process.pid });
  });
  child.once("error", (error) => {
    publish(join(root, `${role}.spawn-error`), {
      parent: process.pid,
      code: "code" in error ? String(error.code) : "UNKNOWN",
    });
    throw error;
  });
  child.unref();
}

/**
 * Исполняет реальные команды fixture: echo либо три уровня живого дерева с PID-барьером.
 */
async function runActor(): Promise<void> {
  const [requestedRole, root] = process.argv.slice(2);
  const detached = requestedRole?.endsWith("-detached") ?? false;
  const role = requestedRole?.replace(/-detached$/, "");
  if (role === "duplex") {
    await new Promise<void>((resolve, reject) => {
      process.stderr.write(Buffer.alloc(256 * 1024, 65), (error) =>
        error ? reject(error) : resolve(),
      );
    });
    for await (const chunk of process.stdin) {
      process.stdout.write(chunk);
    }
    return;
  }
  if (role === "echo") {
    for await (const chunk of process.stdin) {
      process.stdout.write(chunk);
    }
    process.stderr.write("диагностика команды\n");
    process.exitCode = Number(process.argv[3] ?? 0);
    return;
  }
  if (!root) {
    throw new Error("Не указан каталог процессной fixture");
  }
  publish(join(root, `${role}.started`), { pid: process.pid, parent: process.ppid });
  process.on("SIGTERM", () => {});
  if (role === "leaf") {
    publish(join(root, "leaf.ready"), process.pid);
  } else if (role === "branch") {
    descendant("leaf", root, detached);
    await waitFile(join(root, "leaf.ready"));
    publish(join(root, "branch.ready"), process.pid);
  } else if (role === "tree") {
    descendant("branch", root, detached);
    await waitFile(join(root, "branch.ready"));
    publish(join(root, "tree.ready"), {
      command: process.pid,
      anchor: process.ppid,
      branch: JSON.parse(readFileSync(join(root, "branch.ready"), "utf8")),
      leaf: JSON.parse(readFileSync(join(root, "leaf.ready"), "utf8")),
    });
    await waitFile(join(root, "release"));
    if (readFileSync(join(root, "release"), "utf8") === "budget") {
      process.stdout.write(Buffer.alloc(80, 65));
      process.stderr.write(Buffer.alloc(80, 66));
      await waitFile(join(root, "stop"));
    }
    process.stdout.write("command-completed");
    process.exit(0);
  } else {
    throw new Error("Неизвестная роль процессной fixture");
  }
  await waitFile(join(root, "stop"));
}

await runActor();
