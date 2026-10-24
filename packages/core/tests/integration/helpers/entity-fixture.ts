import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { RelayError, type EntityRecord, type WriteOptions } from "@relay/contracts";
import { ProjectDatabase } from "@relay/storage";

/**
 * Передаёт тесту отдельную файловую SQLite со штатными начальными записями проекта.
 * Владеет соединением и каталогом: закрывает и удаляет их даже при отказе callback.
 * Асинхронный callback завершается до очистки; синхронный сохраняет прежний путь
 * без Promise. Дополнительные предметные данные создаёт сам тест.
 */
export function withEntityDatabase<T>(run: (db: ProjectDatabase) => Promise<T>): Promise<T>;
export function withEntityDatabase<T>(run: (db: ProjectDatabase) => T): T;
export function withEntityDatabase<T>(
  run: (db: ProjectDatabase) => T | Promise<T>,
): T | Promise<T> {
  const artifacts = resolve(
    import.meta.dir,
    "../../../../../.artifacts",
    new Date().toISOString().slice(0, 10),
  );
  mkdirSync(artifacts, { recursive: true });
  const directory = mkdtempSync(join(artifacts, "core-reading-tests-"));
  let db: ProjectDatabase | undefined;

  /**
   * Освобождает файловую fixture после завершения callback, включая отказ.
   */
  function cleanup(): void {
    try {
      db?.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  let result: T | Promise<T>;
  try {
    db = ProjectDatabase.create(join(directory, "project.sqlite"), {
      id: crypto.randomUUID(),
      name: "Тестовый проект",
      slug: "test-project",
    });
    result = run(db);
  } catch (error) {
    cleanup();
    throw error;
  }
  if (result instanceof Promise) {
    return result.finally(cleanup);
  }
  cleanup();
  return result;
}

/**
 * Проверяет предметный класс и код синхронного отказа и возвращает ошибку для
 * дополнительных утверждений. Успех операции и постороннее исключение проваливают тест.
 */
export function expectRelayError(operation: () => unknown, code: string): RelayError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(RelayError);
    if (!(error instanceof RelayError)) {
      throw error;
    }
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`Ожидалась ошибка ${code}`);
}

/**
 * Ожидает отказ асинхронной операции, проверяет класс и предметный код ошибки.
 * Возвращает ошибку для дополнительных утверждений; успех и посторонний отказ
 * проваливают тест после завершения операции.
 */
export async function expectAsyncRelayError(
  operation: () => Promise<unknown>,
  code: string,
): Promise<RelayError> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(RelayError);
    if (!(error instanceof RelayError)) {
      throw error;
    }
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`Ожидалась ошибка ${code}`);
}

/**
 * Формирует параметры записи из переданного снимка, не перечитывая свежую ревизию.
 * Автор по умолчанию — tester; ресурсами helper не владеет.
 */
export function entityWriteOptions(
  entity: Pick<EntityRecord, "revision">,
  actor = "tester",
): WriteOptions {
  return { actor, ifRevision: entity.revision };
}
