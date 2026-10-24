import { Database } from "bun:sqlite";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { RelayError } from "@relay/contracts";
import { restoreProject } from "@relay/project-runtime";
import { ProjectDatabase } from "@relay/storage";

/**
 * Сохраняет код native SQLite и errno из цепочки RelayError без потери исходного сообщения.
 */
function failureDescription(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const code = "code" in error ? String(error.code) : error.name;
  const errno = "errno" in error ? String(error.errno) : "none";
  const cause = error.cause === undefined ? "" : `; cause=[${failureDescription(error.cause)}]`;
  return `${code}, errno=${errno}, ${error.message}${cause}`;
}

/**
 * Наблюдает только metadata: отдельный FD datafile не открывается и POSIX fcntl-lock не снимается.
 */
function fileObservations(paths: readonly string[]): string {
  return JSON.stringify(
    paths.map((path) => {
      if (!existsSync(path)) {
        return { path, exists: false };
      }
      const stat = lstatSync(path, { bigint: true });
      return {
        path,
        exists: true,
        device: String(stat.dev),
        inode: String(stat.ino),
        links: String(stat.nlink),
        bytes: String(stat.size),
        birthtimeNs: String(stat.birthtimeNs),
      };
    }),
  );
}

/**
 * Читает реальное соединение: сообщает точное сохранение outbox/replicaId либо native причину отказа.
 * Для диагностики ошибка записывается как ошибка, а не подменяется пустыми данными.
 */
function connectionObservation(
  database: ProjectDatabase,
  expectedOutbox: string,
  replicaId: string,
): string {
  try {
    const outbox = database.getReplicationOutbox();
    return JSON.stringify({
      result: "readable",
      outboxPreserved: JSON.stringify(outbox) === expectedOutbox,
      replicaIdPreserved: database.getReplicationState().replicaId === replicaId,
      outboxCount: outbox.length,
      projectName: database.get(database.projectId)?.data.name,
    });
  } catch (error) {
    return JSON.stringify({ result: "error", failure: failureDescription(error) });
  }
}

/**
 * Повторяет две реальные readonly-границы resume: техническое открытие и предметный read snapshot.
 */
function validatePublicDatabase(path: string): void {
  ProjectDatabase.openReadonly(path).close();
  const reader = ProjectDatabase.openReadonly(path);
  try {
    reader.snapshot(() => {
      reader.get(reader.projectId);
      reader.getReplicationState();
      reader.getReplicationOutbox();
    });
  } finally {
    reader.close();
  }
}

/**
 * Изолирует событие unlink одного private hardlink на настоящем restore и живом public WAL.
 * Контроль выполняет те же открытия/чтения без unlink. Оборот event loop даёт отдельное наблюдение
 * асинхронной доставки vnode-события; ожидания по времени и retries отсутствуют.
 * Все данные принадлежат fixture; probe закрывает соединения и удаляет свой каталог.
 */
async function probeCase(
  root: string,
  operation: "control" | "unlink-private-hardlink",
): Promise<void> {
  const directory = join(root, operation);
  const cwd = join(directory, "cwd");
  const home = join(directory, "home");
  mkdirSync(cwd, { recursive: true });
  const projectId = `vnode-${operation}`;
  const databasePath = join(home, "projects", projectId, "project.sqlite");
  let stagingPath = "";
  try {
    restoreProject({ cwd, home }, projectId, (path) => {
      stagingPath = path;
      ProjectDatabase.create(path, { id: projectId, name: "До late write", slug: "vnode" }).close();
      writeFileSync(join(cwd, "relay.config.json"), JSON.stringify({ version: 1, projectId }));
    });
    throw new Error("Не достигнут ожидаемый конфликт config в vnode fixture");
  } catch (error) {
    if (!(error instanceof RelayError && error.code === "RESTORE_RECOVERY_REQUIRED")) {
      throw error;
    }
  }
  if (!stagingPath || !existsSync(databasePath) || !existsSync(stagingPath)) {
    throw new Error("Не опубликована ожидаемая пара hardlink vnode fixture");
  }
  const paths = [databasePath, stagingPath, `${databasePath}-wal`, `${databasePath}-shm`];
  const database = ProjectDatabase.open(databasePath);
  let expectedOutbox = "";
  let replicaId = "";
  try {
    const project = database.get(projectId);
    if (!project) {
      throw new Error("Не найден проект vnode fixture");
    }
    database.update(
      {
        ...project,
        revision: project.revision + 1,
        data: { ...project.data, name: "Принятый живой WAL" },
      },
      project.revision,
    );
    expectedOutbox = JSON.stringify(database.getReplicationOutbox());
    replicaId = database.getReplicationState().replicaId;
    console.log(
      `${operation}: before-validation ${connectionObservation(database, expectedOutbox, replicaId)}`,
    );
    validatePublicDatabase(databasePath);
    console.log(
      `${operation}: after-validation ${connectionObservation(database, expectedOutbox, replicaId)}`,
    );
    console.log(`${operation}: files-before ${fileObservations(paths)}`);
    if (operation === "unlink-private-hardlink") {
      unlinkSync(stagingPath);
    }
    console.log(`${operation}: files-after ${fileObservations(paths)}`);
    console.log(
      `${operation}: after-operation ${connectionObservation(database, expectedOutbox, replicaId)}`,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    console.log(
      `${operation}: next-event-loop-turn ${connectionObservation(database, expectedOutbox, replicaId)}`,
    );
    if (operation === "unlink-private-hardlink") {
      unlinkSync(join(dirname(stagingPath), "publication.json"));
      console.log(
        `${operation}: after-private-marker ${connectionObservation(database, expectedOutbox, replicaId)}`,
      );
      rmdirSync(dirname(stagingPath));
      console.log(
        `${operation}: after-staging-directory ${connectionObservation(database, expectedOutbox, replicaId)}`,
      );
      unlinkSync(join(dirname(databasePath), ".restore-publication.json"));
      console.log(
        `${operation}: after-public-marker ${connectionObservation(database, expectedOutbox, replicaId)}`,
      );
    }
  } finally {
    try {
      database.close();
    } catch (error) {
      console.log(`${operation}: close-error ${failureDescription(error)}`);
    }
  }
  try {
    const reopened = ProjectDatabase.openReadonly(databasePath);
    try {
      console.log(
        `${operation}: reopened ${connectionObservation(reopened, expectedOutbox, replicaId)}`,
      );
    } finally {
      reopened.close();
    }
  } catch (error) {
    console.log(`${operation}: reopen-error ${failureDescription(error)}`);
  }
  console.log(`${operation}: final-files ${fileObservations(paths)}`);
  rmSync(directory, { recursive: true, force: true });
}

const parent = process.argv[2];
if (!parent) {
  throw new Error("Не задан изолированный каталог vnode diagnostics");
}
const root = mkdtempSync(join(parent, "vnode-probe-"));
try {
  const metadata = new Database(":memory:");
  try {
    console.log(
      JSON.stringify({
        platform: process.platform,
        bun: Bun.version,
        sqlite: metadata
          .query("SELECT sqlite_version() AS version, sqlite_source_id() AS source")
          .get(),
      }),
    );
  } finally {
    metadata.close();
  }
  await probeCase(root, "control");
  await probeCase(root, "unlink-private-hardlink");
} finally {
  rmSync(root, { recursive: true, force: true });
}
