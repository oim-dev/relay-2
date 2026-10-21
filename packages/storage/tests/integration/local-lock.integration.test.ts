import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import { RelayError } from "@relay/contracts";
import { withLocalFileLock } from "../../src/local-lock/local-lock";
import { expectRelayError } from "./helpers/project-database-fixture";
import { LocalLockWriter } from "./helpers/local-lock-writer";
import type { LockProcessMode } from "./helpers/local-lock-process.types";

const artifacts = resolve(
  import.meta.dir,
  "../../../..",
  ".artifacts",
  new Date().toISOString().slice(0, 10),
  "style-refactor",
);
let directory: string;
let path: string;
let writers: LocalLockWriter[];

/**
 * Регистрирует нового участника для обязательного завершения после теста, включая отказ барьера.
 */
function startWriter(mode: LockProcessMode, actor: string): LocalLockWriter {
  const writer = new LocalLockWriter(path, mode, actor);
  writers.push(writer);
  return writer;
}

beforeEach(() => {
  mkdirSync(artifacts, { recursive: true });
  directory = mkdtempSync(join(artifacts, "storage-local-lock-"));
  path = join(directory, "relay.workspace.json");
  writeFileSync(path, JSON.stringify({ actors: [] }));
  writers = [];
});

afterEach(async () => {
  try {
    await Promise.all(writers.map((writer) => writer.stop()));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Межпроцессный mutex локального JSON", () => {
  test("возвращает результат, освобождается при исключении и не требует базы проекта", () => {
    const failure = new RelayError("INVALID_JSON", "Ошибка вызывающего", 2);

    const result = withLocalFileLock(path, () => 42);

    expect(result).toBe(42);
    expect(existsSync(`${path}.lock.sqlite`)).toBe(true);
    expect(() =>
      withLocalFileLock(path, () => {
        throw failure;
      }),
    ).toThrow(failure);
    expect(withLocalFileLock(path, () => "свободно")).toBe("свободно");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ actors: [] });
  });

  test("async callback отклоняется до вызова и создания файла mutex", () => {
    let called = false;

    expectRelayError(() => {
      // @ts-expect-error Async callback запрещён статически и при выполнении.
      withLocalFileLock(path, async () => {
        called = true;
      });
    }, "ASYNC_TRANSACTION");

    expect(called).toBe(false);
    expect(existsSync(`${path}.lock.sqlite`)).toBe(false);
  });

  test("возвращённый Promise отклоняется с освобождением mutex", () => {
    const before = readFileSync(path);

    expectRelayError(() => {
      // @ts-expect-error Возвращать Promise из синхронного callback тоже запрещено.
      withLocalFileLock(path, () => Promise.reject(new Error("Асинхронный callback")));
    }, "ASYNC_TRANSACTION");

    expect(withLocalFileLock(path, () => "свободно")).toBe("свободно");
    expect(readFileSync(path)).toEqual(before);
  });

  test("два процесса сериализуют read-modify-write без потери предыдущей записи", async () => {
    const first = startWriter("hold", "первый");
    const second = startWriter("write", "второй");
    expect(await first.next()).toBe("ready");
    expect(await second.next()).toBe("ready");
    first.signal();
    expect(await first.next()).toBe("attempting");
    expect(await first.next()).toBe("locked");

    second.signal();
    second.closeInput();
    expect(await second.next()).toBe("attempting");
    first.signal();
    first.closeInput();

    expect(await first.next()).toBe("done");
    expect(await second.next()).toBe("locked");
    expect(await second.next()).toBe("done");
    expect(await first.exited).toBe(0);
    expect(await second.exited).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ actors: ["первый", "второй"] });
  });

  test("занятый mutex возвращает WORKSPACE_BUSY/4 и не запускает callback второго процесса", async () => {
    const first = startWriter("hold", "владелец");
    const second = startWriter("write", "конкурент");
    expect(await first.next()).toBe("ready");
    expect(await second.next()).toBe("ready");
    first.signal();
    expect(await first.next()).toBe("attempting");
    expect(await first.next()).toBe("locked");

    second.signal();
    second.closeInput();

    expect(await second.next()).toBe("attempting");
    expect(JSON.parse(await second.next())).toEqual({ code: "WORKSPACE_BUSY", exitCode: 4 });
    expect(await second.exited).toBe(4);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ actors: [] });
    first.signal();
    first.closeInput();
    expect(await first.next()).toBe("done");
    expect(await first.exited).toBe(0);
    expect(withLocalFileLock(path, () => "свободно")).toBe("свободно");
  });

  test("SIGKILL владельца освобождает mutex без удаления или замены служебного файла", async () => {
    const first = startWriter("hold", "убитый владелец");
    const second = startWriter("write", "следующий владелец");
    expect(await first.next()).toBe("ready");
    expect(await second.next()).toBe("ready");
    first.signal();
    expect(await first.next()).toBe("attempting");
    expect(await first.next()).toBe("locked");
    const inode = statSync(`${path}.lock.sqlite`).ino;
    second.signal();
    second.closeInput();
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
