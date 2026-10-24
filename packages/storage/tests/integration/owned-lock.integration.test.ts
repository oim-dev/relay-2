import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { acquireLocalLock } from "../../src/local-lock/local-lock";

/**
 * Создаёт отдельный канонический путь mutex и удаляет каталог лишь после освобождения участников.
 */
async function withLockPath(run: (path: string) => Promise<void>): Promise<void> {
  const artifacts = resolve(
    import.meta.dir,
    "../../../..",
    ".artifacts",
    new Date().toISOString().slice(0, 10),
    "git-sync-implementation/core",
  );
  mkdirSync(artifacts, { recursive: true });
  const directory = mkdtempSync(join(artifacts, "owned-lock-"));
  try {
    await run(join(directory, "worker.lock.sqlite"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("Явное владение worker mutex", () => {
  test("await не освобождает mutex, повтор release безопасен и сохраняет inode", async () => {
    await withLockPath(async (path) => {
      const first = acquireLocalLock(path);
      const inode = statSync(path).ino;
      try {
        await Promise.resolve();
        expect(() => acquireLocalLock(path)).toThrow(
          expect.objectContaining({ code: "LOCAL_LOCK_BUSY", exitCode: 4 }),
        );
      } finally {
        first.release();
        first.release();
      }

      const next = acquireLocalLock(path);
      try {
        expect(statSync(path).ino).toBe(inode);
      } finally {
        next.release();
      }
    });
  });

  test("SIGKILL отдельного владельца освобождает mutex для нового процесса без удаления файла", async () => {
    await withLockPath(async (path) => {
      const child = Bun.spawn(
        [process.execPath, join(import.meta.dir, "helpers/owned-lock-process.ts"), path],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      );
      const errors = new Response(child.stderr).text();
      try {
        const reader = child.stdout.getReader();
        const ready = await reader.read();
        expect(new TextDecoder().decode(ready.value)).toBe("locked\n");
        const inode = statSync(path).ino;
        expect(() => acquireLocalLock(path)).toThrow(
          expect.objectContaining({ code: "LOCAL_LOCK_BUSY" }),
        );

        child.kill("SIGKILL");
        await child.exited;
        const acquired = acquireLocalLock(path);
        try {
          expect(statSync(path).ino).toBe(inode);
        } finally {
          acquired.release();
        }
        reader.releaseLock();
        expect(await errors).toBe("");
      } finally {
        child.kill("SIGKILL");
        await child.exited;
        await errors;
      }
    });
  });
});
