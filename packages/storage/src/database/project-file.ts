/**
 * Жизненный цикл файла и технической схемы БД. Транзакцией создания и начальных
 * сущностей владеет ProjectDatabase; несовместимые существующие базы не изменяются.
 */
import { Database } from "bun:sqlite";
import { closeSync, openSync, rmSync, statSync } from "node:fs";
import { RelayError, type EntityRecord } from "@relay/contracts";
import { APPLICATION_ID, SCHEMA, SCHEMA_VERSION } from "../sqlite/schema";
import { assertSqlText } from "../entities/entity-sql-text";
import { errorCode, storageError } from "../sqlite/sqlite-errors";
import { SQLITE_BUSY_TIMEOUT_MS, SQLITE_WAL_REOPEN_PAUSE_MS } from "../sqlite/sqlite.constants";
import { projectDatabaseMessages } from "./project-database.messages";
import type {
  ApplicationIdRow,
  JournalModeRow,
  ProjectMetadata,
  ProjectStateRow,
  SchemaVersionRow,
  OpenedProjectFile,
} from "./project-database.types";

/**
 * Проверяет метаданные и эксклюзивно резервирует пустой файл с правами владельца.
 * Существующий файл не изменяется, включая гонку двух одновременных инициализаций.
 */
export function reserveProjectFile(path: string, project: ProjectMetadata): void {
  assertSqlText(project.id, "projectId");
  for (const field of ["id", "name", "slug"] as const) {
    if (typeof project[field] !== "string" || !project[field].trim()) {
      throw new RelayError(
        "VALIDATION_ERROR",
        projectDatabaseMessages.missingProjectField(field),
        2,
      );
    }
  }
  try {
    closeSync(openSync(path, "wx", 0o600));
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      const exists = new RelayError("DATABASE_EXISTS", projectDatabaseMessages.databaseExists, 4, {
        path,
      });
      exists.cause = error;
      throw exists;
    }
    throw storageError(error, path);
  }
}

/**
 * Удаляет только файл, ранее зарезервированный текущей неуспешной инициализацией, и его WAL.
 * Вызывается после закрытия соединения; чужие существующие базы сюда не передаются.
 */
export function discardProjectFile(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${path}${suffix}`, { force: true });
  }
}

/**
 * Открывает существующий файл с FK и ограниченным ожиданием писателя; readonly запрещает SQL-запись.
 * При успехе владение соединением переходит вызывающему; при отказе настройки оно закрывается.
 */
export function connectProjectFile(
  path: string,
  mode: "readwrite" | "readonly" = "readwrite",
): Database {
  if (!statSync(path).isFile()) {
    throw new RelayError("DATABASE_INVALID", projectDatabaseMessages.notAFile, 1, { path });
  }
  const connection = new Database(path, {
    create: false,
    readonly: mode === "readonly",
    readwrite: mode === "readwrite",
    strict: true,
  });
  try {
    connection.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}; PRAGMA foreign_keys = ON;`);
    return connection;
  } catch (error) {
    connection.close();
    throw error;
  }
}

/**
 * Включает WAL и полную синхронизацию; отказ WAL не допускает работу с иным режимом журнала.
 */
export function configureProjectWal(connection: Database): void {
  const mode = connection.query<JournalModeRow, []>("PRAGMA journal_mode = WAL").get();
  if (mode?.journal_mode !== "wal") {
    throw new RelayError("STORAGE_ERROR", projectDatabaseMessages.walUnavailable);
  }
  connection.exec("PRAGMA synchronous = FULL;");
}

/**
 * Открывает и проверяет проект; принимает только текущую схему без автоматического обновления.
 * Перед каждой RW-попыткой отдельная readonly-проверка читает также живой WAL. Несовместимая
 * база не получает RW-handle, закрытие которого могло бы выполнить checkpoint даже без записи.
 * Рабочее соединение повторяет проверку, чтобы не наследовать projectId предварительного открытия.
 * При конкурирующем DELETE→WAL повторяется только техническое открытие/проверка текущей схемы:
 * отказавшее соединение закрывается до паузы, освобождая его shared lock для другого opener.
 * Preflight, повторы и SQLite busy handler ограничены одним monotonic budget. Readonly не включает
 * WAL и не повторяет открытие. Любая ошибка закрывает принадлежащее функции соединение.
 */
export function openExistingProjectFile(
  path: string,
  mode: "readwrite" | "readonly",
): OpenedProjectFile {
  if (mode === "readonly") {
    const connection = connectProjectFile(path, mode);
    try {
      const projectId = readProjectId(connection, path);
      return { connection, projectId };
    } catch (error) {
      connection.close(true);
      throw error;
    }
  }
  const deadline = performance.now() + SQLITE_BUSY_TIMEOUT_MS;
  for (;;) {
    let connection: Database | undefined;
    try {
      preflightProjectFile(path, deadline);
      connection = connectProjectFile(path);
      applyOpenBudget(connection, deadline);
      const projectId = readProjectId(connection, path);
      applyOpenBudget(connection, deadline);
      configureProjectWal(connection);
      connection.exec(`PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS}`);
      return { connection, projectId };
    } catch (error) {
      connection?.close(true);
      const code = errorCode(error);
      const remaining = deadline - performance.now();
      if (
        (!code.startsWith("SQLITE_BUSY") && !code.startsWith("SQLITE_LOCKED")) ||
        remaining <= 0
      ) {
        throw error;
      }
      Bun.sleepSync(Math.min(SQLITE_WAL_REOPEN_PAUSE_MS, remaining));
    }
  }
}

/**
 * Проверяет приложение, текущую схему и корневую запись через readonly SQLite с обычным WAL-чтением.
 * Закрытие preflight не checkpoint-ит main/WAL; SHM остаётся техническим кешем драйвера.
 * Не передаёт projectId рабочему handle: после повторного открытия он проверяется заново.
 */
function preflightProjectFile(path: string, deadline: number): void {
  const connection = connectProjectFile(path, "readonly");
  try {
    applyOpenBudget(connection, deadline);
    readProjectId(connection, path);
  } finally {
    connection.close(true);
  }
}

/**
 * Ограничивает очередное SQLite-ожидание оставшейся частью общего monotonic бюджета открытия.
 */
function applyOpenBudget(connection: Database, deadline: number): void {
  connection.exec(`PRAGMA busy_timeout=${Math.max(0, Math.ceil(deadline - performance.now()))}`);
}

/**
 * Проверяет заголовок и корневую сущность существующей базы в одном read snapshot.
 * Возвращает постоянный ID проекта; чужая или несовместимая база отклоняется до включения WAL.
 * Любая прежняя версия отклоняется без DDL, изменения журнала и удаления пользовательских файлов.
 */
export function readProjectId(connection: Database, path: string): string {
  return connection
    .transaction(() => {
      const version = connection.query<SchemaVersionRow, []>("PRAGMA user_version").get();
      const application = connection.query<ApplicationIdRow, []>("PRAGMA application_id").get();
      if (application?.application_id !== APPLICATION_ID) {
        throw new RelayError("DATABASE_INVALID", projectDatabaseMessages.foreignDatabase, 1, {
          path,
        });
      }
      requireSupportedSchema(version?.user_version, path);
      const state = connection
        .query<ProjectStateRow, []>(
          `SELECT project_id FROM project_state s JOIN entities e ON e.id = s.project_id
         WHERE s.singleton = 1 AND e.kind = 'project'`,
        )
        .get();
      if (!state) {
        throw new RelayError("DATABASE_INVALID", projectDatabaseMessages.projectMissing, 1, {
          path,
        });
      }
      return state.project_id;
    })
    .deferred();
}

/**
 * Отклоняет любую несовпадающую техническую версию до первой записи.
 */
function requireSupportedSchema(version: number | undefined, path: string): void {
  if (version !== SCHEMA_VERSION) {
    throw new RelayError(
      "SCHEMA_VERSION_UNSUPPORTED",
      projectDatabaseMessages.unsupportedSchema,
      1,
      {
        path,
        expectedVersion: SCHEMA_VERSION,
        actualVersion: version,
      },
    );
  }
}

/**
 * Создаёт схему и нулевое поколение внутри транзакции вызывающего.
 * До commit вызывающий обязан вставить сущность проекта для отложенного FK.
 */
export function initializeProjectSchema(connection: Database, projectId: string): void {
  assertSqlText(projectId, "projectId");
  connection.exec(SCHEMA);
  connection.exec(
    `PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION};`,
  );
  connection.query("INSERT INTO project_state VALUES (1, ?, 0)").run(projectId);
}

/**
 * Формирует начальные карточки проекта, пустого паспорта и продуктовой доски.
 * Новые ID и единая отметка времени принадлежат этой инициализации; записи ещё не сохранены.
 */
export function initialProjectRecords(project: ProjectMetadata): EntityRecord[] {
  const now = new Date().toISOString();
  const initial = {
    revision: 1,
    createdAt: now,
    updatedAt: now,
    createdBy: "system",
    updatedBy: "system",
  };
  return [
    {
      ...initial,
      id: project.id,
      kind: "project",
      key: "PROJECT",
      data: { name: project.name, slug: project.slug },
    },
    { ...initial, id: crypto.randomUUID(), kind: "product", key: "PRODUCT", data: {} },
    {
      ...initial,
      id: crypto.randomUUID(),
      kind: "board",
      key: "BOARD-PRODUCT",
      data: { name: projectDatabaseMessages.productBoardName, slug: "product", prefix: "PRODUCT" },
    },
  ];
}
