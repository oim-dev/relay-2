import { spyOn } from "bun:test";
import { readSync } from "node:fs";
import { homedir } from "node:os";
import { RelayError } from "@relay/contracts";
import { ProjectDatabase, type ProjectMetadata } from "@relay/storage";
import { initializeProject } from "@relay/project-runtime";
import { readInitializationInput } from "./helpers/worker-protocol";
import { workerMessages } from "./helpers/worker.messages";
import type { InitializationResult } from "./helpers/worker.types";

const input = readInitializationInput();

// Проверяем изоляцию до init, чтобы тест default home никогда не записал
// данные в настоящий пользовательский каталог при смене поведения runtime.
if (input.expectedHome !== undefined && homedir() !== input.expectedHome) {
  throw new Error(workerMessages.homeNotIsolated);
}

/**
 * Выполняет одну попытку init и возвращает только предметный результат.
 * Неожиданные исключения завершают процесс с ошибкой, а не маскируются под конфликт init.
 */
function initializeOnce(): void {
  try {
    const result: InitializationResult = { kind: "success", location: initializeProject(input) };
    console.log(JSON.stringify(result));
  } catch (error) {
    if (!(error instanceof RelayError)) {
      throw error;
    }
    const result: InitializationResult = { kind: "failure", code: error.code };
    console.log(JSON.stringify(result));
  } finally {
    process.disconnect?.();
  }
}

/**
 * Выполняет реальный init с барьером после создания SQLite, когда проверка свободного пути пройдена.
 * Синхронное чтение stdin согласует процессы без sleep; родитель отпускает обе публикации вместе.
 */
function initializeWithPublicationBarrier(): void {
  const createDatabase = ProjectDatabase.create;
  /**
   * Создаёт настоящую базу и удерживает её до разрешения публикации от координатора.
   * При разрыве барьера закрывает соединение до отката init, не оставляя открытых ресурсов.
   */
  function createBeforeBarrier(path: string, project: ProjectMetadata): ProjectDatabase {
    const database = createDatabase.call(ProjectDatabase, path, project);
    try {
      process.send?.("ready");
      const permission = Buffer.alloc(1);
      const size = readSync(0, permission, 0, permission.length, null);
      if (size !== permission.length || permission.toString() !== "g") {
        throw new Error(workerMessages.publicationNotReleased);
      }
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  }
  const create = spyOn(ProjectDatabase, "create").mockImplementation(createBeforeBarrier);
  try {
    initializeOnce();
  } finally {
    create.mockRestore();
  }
}

if (input.synchronizePublication) {
  initializeWithPublicationBarrier();
} else {
  process.on("message", (message: unknown) => {
    if (message === "go") {
      initializeOnce();
    }
  });
  process.send?.("ready");
}
