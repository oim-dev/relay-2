/**
 * Жизненный цикл файла и технической схемы БД. Транзакцией создания и начальных
 * сущностей владеет ProjectDatabase; техническая миграция существующей БД имеет свою транзакцию.
 */
import { Database } from "bun:sqlite";
import { closeSync, openSync, rmSync, statSync } from "node:fs";
import { RelayError, type EntityRecord } from "@relay/contracts";
import { APPLICATION_ID, SCHEMA, SCHEMA_VERSION } from "../sqlite/schema";
import { BATCH_RECEIPT_SCHEMA } from "../sqlite/batch-schema";
import { REPLICATION_SCHEMA, REPLICATION_BACKFILL } from "../sqlite/replication-schema";
import { flushReplicationQueue } from "../replication/replication-store";
import { PROJECT_WRITE_TRIGGERS } from "../sqlite/entity-triggers";
import {
  migrateComponents,
  enqueueComponentBaseline,
  assertLegacyOwnerVersions,
} from "../components/component-migration";
import { upgradeReplicationV4 } from "../replication/replication-migration";
import { COMMAND_SCHEMA } from "../sqlite/command-schema";
import { assertSqlText } from "../entities/entity-sql-text";
import { assertLegacyTextEncoding } from "../entities/entity-legacy-text";
import { upgradeCommentTextStorage } from "../entities/comment-text";
import { errorCode, storageError } from "../sqlite/sqlite-errors";
import { SQLITE_BUSY_TIMEOUT_MS } from "../sqlite/sqlite.constants";
import { projectDatabaseMessages } from "./project-database.messages";
import type {
  ApplicationIdRow,
  JournalModeRow,
  ProjectMetadata,
  ProjectStateRow,
  SchemaVersionRow,
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
 * Проверяет заголовок и корневую сущность существующей базы без её переинициализации.
 * Возвращает постоянный ID проекта; чужая или несовместимая база отклоняется до включения WAL.
 * В режиме migrate совместимые v1/v2/v3 получают v4 в атомарной технической миграции.
 * Режим readonly принимает только текущую схему, без миграций и изменения журнала.
 */
export function readProjectId(
  connection: Database,
  path: string,
  mode: "migrate" | "readonly" = "migrate",
): string {
  const version = connection.query<SchemaVersionRow, []>("PRAGMA user_version").get();
  const application = connection.query<ApplicationIdRow, []>("PRAGMA application_id").get();
  if (application?.application_id !== APPLICATION_ID) {
    throw new RelayError("DATABASE_INVALID", projectDatabaseMessages.foreignDatabase, 1, { path });
  }
  requireSupportedSchema(version?.user_version, path, mode);
  const state = connection
    .query<ProjectStateRow, []>(
      `SELECT project_id FROM project_state s JOIN entities e ON e.id = s.project_id
       WHERE s.singleton = 1 AND e.kind = 'project'`,
    )
    .get();
  if (!state) {
    throw new RelayError("DATABASE_INVALID", projectDatabaseMessages.projectMissing, 1, { path });
  }
  if (version?.user_version !== SCHEMA_VERSION) {
    migrateProjectSchema(connection, path);
  }
  return state.project_id;
}

/**
 * Отклоняет неизвестную техническую версию до записи и после ожидания замка миграции.
 * Readonly допускает только текущую схему, поскольку миграция потребовала бы записи.
 */
function requireSupportedSchema(
  version: number | undefined,
  path: string,
  mode: "migrate" | "readonly" = "migrate",
): void {
  if (
    version !== SCHEMA_VERSION &&
    (mode === "readonly" || (version !== 1 && version !== 2 && version !== 3))
  ) {
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
 * Под замком записи повторяет проверку версии и добавляет журнал/outbox без изменения данных v1/v2.
 * Конкурентный open может уже завершить миграцию; DDL и user_version откатываются вместе.
 */
function migrateProjectSchema(connection: Database, path: string): void {
  connection.exec("BEGIN IMMEDIATE");
  try {
    const version = connection.query<SchemaVersionRow, []>("PRAGMA user_version").get();
    requireSupportedSchema(version?.user_version, path);
    if (version?.user_version !== SCHEMA_VERSION) {
      assertLegacyTextEncoding(connection);
    }
    if (version?.user_version === 3) {
      assertLegacyOwnerVersions(connection);
    }
    if (version?.user_version === 1) {
      connection.exec(BATCH_RECEIPT_SCHEMA);
    }
    const previous = version?.user_version;
    if (previous === 1 || previous === 2) {
      connection.exec(REPLICATION_SCHEMA);
      for (const [name, sql] of Object.entries(PROJECT_WRITE_TRIGGERS)) {
        connection.exec(`DROP TRIGGER ${name}`);
        connection.exec(sql);
      }
    }
    if (previous !== SCHEMA_VERSION) {
      migrateComponents(connection);
      upgradeReplicationV4(connection);
      upgradeCommentTextStorage(connection);
      connection.exec(COMMAND_SCHEMA);
      if (previous === 1 || previous === 2) {
        connection.exec(REPLICATION_BACKFILL);
        enqueueComponentBaseline(connection);
        flushReplicationQueue(connection, true);
      }
      connection.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
    connection.exec("COMMIT");
  } catch (error) {
    connection.exec("ROLLBACK");
    throw error;
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
