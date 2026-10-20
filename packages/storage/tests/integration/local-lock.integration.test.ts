import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RelayError } from "@relay/contracts";
import { withLocalFileLock } from "../../src";

const artifacts = resolve(
  import.meta.dir,
  "../../../..",
  ".artifacts",
  new Date().toISOString().slice(0, 10),
);
let directory: string;
let path: string;
let processes: Array<{ process: ChildProcessWithoutNullStreams; exited: Promise<number | null> }>;

beforeEach(() => {
  mkdirSync(artifacts, { recursive: true });
  directory = mkdtempSync(join(artifacts, "storage-local-lock-"));
  path = join(directory, "relay.workspace.json");
  writeFileSync(path, JSON.stringify({ actors: [] }));
  processes = [];
});

afterEach(async () => {
  for (const child of processes) if (child.process.exitCode === null) child.process.kill("SIGKILL");
  await Promise.all(processes.map((child) => child.exited));
  rmSync(directory, { recursive: true, force: true });
});

function writer(mode: "hold" | "write", actor: string) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./local-lock-process.ts", import.meta.url)), path, mode, actor],
    {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 4000,
      killSignal: "SIGKILL",
    },
  );
  const lines: string[] = [];
  const waiting: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
  let output = "";
  let errors = "";
  let closed = false;
  child.stderr.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    let newline: number;
    while ((newline = output.indexOf("\n")) !== -1) {
      const line = output.slice(0, newline);
      output = output.slice(newline + 1);
      const waiter = waiting.shift();
      if (waiter) waiter.resolve(line);
      else lines.push(line);
    }
  });
  const exited = new Promise<number | null>((resolveExit) => {
    child.on("error", (error) => {
      for (const waiter of waiting.splice(0)) waiter.reject(error);
    });
    child.on("close", (code) => {
      closed = true;
      for (const waiter of waiting.splice(0))
        waiter.reject(new Error(`Процесс закрыт (${code}): ${errors}`));
      resolveExit(code);
    });
  });
  processes.push({ process: child, exited });
  return {
    process: child,
    exited,
    signal: () => child.stdin.write("!"),
    next: () => {
      const line = lines.shift();
      if (line !== undefined) return Promise.resolve(line);
      if (closed) return Promise.reject(new Error(`Процесс уже закрыт: ${errors}`));
      return new Promise<string>((resolveLine, reject) =>
        waiting.push({ resolve: resolveLine, reject }),
      );
    },
  };
}

function expectCode(operation: () => unknown, code: string): void {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RelayError);
  expect(caught).toMatchObject({ code });
}

describe("Межпроцессный mutex локального JSON", () => {
  test("возвращает результат, освобождается при исключении и не требует базы проекта", () => {
    expect(withLocalFileLock(path, () => 42)).toBe(42);
    expect(existsSync(`${path}.lock.sqlite`)).toBe(true);
    const failure = new RelayError("INVALID_JSON", "Ошибка вызывающего", 2);
    expect(() =>
      withLocalFileLock(path, () => {
        throw failure;
      }),
    ).toThrow(failure);
    expect(withLocalFileLock(path, () => "свободно")).toBe("свободно");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ actors: [] });
  });

  test("отклоняет async до вызова и возвращённый Promise с освобождением mutex", () => {
    let called = false;
    expectCode(() => {
      // @ts-expect-error Async callback запрещён статически и при выполнении.
      withLocalFileLock(path, async () => {
        called = true;
      });
    }, "ASYNC_TRANSACTION");
    expect(called).toBe(false);
    expect(existsSync(`${path}.lock.sqlite`)).toBe(false);
    expectCode(() => {
      // @ts-expect-error Возвращать Promise из синхронного callback тоже запрещено.
      withLocalFileLock(path, () => Promise.reject(new Error("Асинхронный callback")));
    }, "ASYNC_TRANSACTION");
    expect(withLocalFileLock(path, () => "свободно")).toBe("свободно");
  });

  test("два процесса сериализуют read-modify-write без потери предыдущей записи", async () => {
    const first = writer("hold", "первый");
    const second = writer("write", "второй");
    expect(await first.next()).toBe("ready");
    expect(await second.next()).toBe("ready");
    first.signal();
    expect(await first.next()).toBe("attempting");
    expect(await first.next()).toBe("locked");
    second.signal();
    expect(await second.next()).toBe("attempting");
    first.signal();
    expect(await first.next()).toBe("done");
    expect(await second.next()).toBe("locked");
    expect(await second.next()).toBe("done");
    expect(await first.exited).toBe(0);
    expect(await second.exited).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ actors: ["первый", "второй"] });
  });

  test("занятый mutex возвращает WORKSPACE_BUSY/4 и не запускает callback второго процесса", async () => {
    const first = writer("hold", "владелец");
    const second = writer("write", "конкурент");
    expect(await first.next()).toBe("ready");
    expect(await second.next()).toBe("ready");
    first.signal();
    expect(await first.next()).toBe("attempting");
    expect(await first.next()).toBe("locked");
    second.signal();
    expect(await second.next()).toBe("attempting");
    expect(JSON.parse(await second.next())).toEqual({ code: "WORKSPACE_BUSY", exitCode: 4 });
    expect(await second.exited).toBe(4);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ actors: [] });
    first.signal();
    expect(await first.next()).toBe("done");
    expect(await first.exited).toBe(0);
    expect(withLocalFileLock(path, () => "свободно")).toBe("свободно");
  });

  test("SIGKILL владельца освобождает mutex без удаления или замены служебного файла", async () => {
    const first = writer("hold", "убитый владелец");
    const second = writer("write", "следующий владелец");
    expect(await first.next()).toBe("ready");
    expect(await second.next()).toBe("ready");
    first.signal();
    expect(await first.next()).toBe("attempting");
    expect(await first.next()).toBe("locked");
    const inode = statSync(`${path}.lock.sqlite`).ino;
    second.signal();
    expect(await second.next()).toBe("attempting");
    first.process.kill("SIGKILL");
    await first.exited;
    expect(first.process.signalCode).toBe("SIGKILL");
    expect(await second.next()).toBe("locked");
    expect(await second.next()).toBe("done");
    expect(await second.exited).toBe(0);
    expect(statSync(`${path}.lock.sqlite`).ino).toBe(inode);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ actors: ["следующий владелец"] });
  });
});
