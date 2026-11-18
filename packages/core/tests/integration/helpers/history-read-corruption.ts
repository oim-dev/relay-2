import { Database } from "bun:sqlite";
import {
  splitComponentRecord,
  type HistoryCheckpoint,
  type HistorySession,
} from "@relay/contracts";
import { portableEntity, versionComponent, type ProjectDatabase } from "@relay/storage";
import { currentHistoryRun } from "../history-fixture";

/**
 * Записывает повреждение внешней SQLite отдельным синхронным соединением без проверки FK.
 * Изменения атомарны; соединение закрывается при любом исходе. Публичные соединения сохраняют FK.
 * Очередь обмена не создаётся: helper моделирует внешнее повреждение, а не предметную команду.
 */
function withExternalHistoryWrite(db: ProjectDatabase, operation: (raw: Database) => void): void {
  const raw = new Database(db.path, { create: false, readwrite: true, strict: true });
  try {
    raw.exec("PRAGMA foreign_keys=OFF");
    raw.transaction(() => operation(raw)).immediate();
  } finally {
    raw.close();
  }
}

/**
 * Создаёт полное версионированное назначение ID либо текущего ключа нового материала.
 * Вызывающий удерживает транзакцию вставки; существующие адреса не переназначаются.
 */
function insertMaterialAddress(raw: Database, material: HistoryCheckpoint, ref: string): void {
  const part = versionComponent({
    ownerId: material.id,
    kind: "address-assignment",
    id: crypto.randomUUID(),
    position: "V",
    parents: [],
    deleted: false,
    value: { ref },
  });
  raw
    .query(
      `INSERT INTO object_keys(owner_id,id,position,version,parents_json,deleted,ref,is_current)
       VALUES(?,?,?,?,'[]',0,?,?)`,
    )
    .run(material.id, part.id, part.position, part.version, ref, ref === material.key ? 1 : 0);
}

/**
 * Добавляет продолжение с согласованными session/run и уникальным sequence чужой сессии,
 * но намеренно оставляет intentId исходной сессии. Нарушается только составной FK намерения.
 * Шаблон должен иметь пустые references/acceptedSessionIds; все скаляры и текстовые carriers
 * копируются из его реальной строки. ID, адреса, local CAS и переносимая версия создаются явно.
 * CAS обеих существующих сессий и outbox не меняются; возвращается точная вставленная карточка.
 */
export function insertForeignIntentMaterial(
  db: ProjectDatabase,
  intent: HistoryCheckpoint,
  session: HistorySession,
  kind: "progress" | "result",
  sequence: number,
): HistoryCheckpoint {
  if (intent.data.references.length !== 0 || intent.data.acceptedSessionIds.length !== 0) {
    throw new Error("Шаблон повреждённого материала должен иметь пустые исторические связи");
  }
  const run = currentHistoryRun(session);
  const id = crypto.randomUUID();
  const material: HistoryCheckpoint = {
    ...intent,
    id,
    key: `CP-${id}`,
    createdBy: run.actor,
    updatedBy: run.actor,
    data: {
      ...intent.data,
      kind,
      sessionId: session.id,
      runId: run.id,
      actor: run.actor,
      intentId: intent.id,
      sequence,
      sessionRevision: session.revision + 1,
    },
  };
  const primary = portableEntity(material);
  withExternalHistoryWrite(db, (raw) => {
    const template = raw
      .query<Record<string, string | number | null>, [string]>(
        "SELECT * FROM checkpoints WHERE id=?",
      )
      .get(intent.id);
    if (template === null) {
      throw new Error("Не найдена физическая строка исходного намерения");
    }
    const row = {
      ...template,
      id,
      created_by: material.createdBy,
      updated_by: material.updatedBy,
      checkpoint_kind: kind,
      session_id: session.id,
      run_id: run.id,
      actor: run.actor,
      intent_id: intent.id,
      sequence,
      session_revision: material.data.sessionRevision,
    };
    raw.query("INSERT INTO object_ids(id,kind) VALUES(?,'work-checkpoint')").run(id);
    raw.query("INSERT INTO local_entity_revisions(entity_id,revision) VALUES(?,1)").run(id);
    // Имена колонок получены из схемы конкретной checkpoints, а не из пользовательского JSON.
    const columns = Object.keys(row);
    raw
      .query(
        `INSERT INTO checkpoints(${columns.map((column) => `"${column}"`).join(",")})
         VALUES(${columns.map(() => "?").join(",")})`,
      )
      .run(...Object.values(row));
    raw
      .query(
        "INSERT INTO replication_entity_versions(entity_id,version,parents_json) VALUES(?,?,'[]')",
      )
      .run(id, primary.version);
    insertMaterialAddress(raw, material, material.id);
    insertMaterialAddress(raw, material, material.key);
    raw.exec("UPDATE project_state SET generation=generation+1 WHERE singleton=1");
  });
  return material;
}

/**
 * Повреждает одну сторону происхождения уже существующего ребёнка во внешней SQLite.
 * Для null отключает CHECK только в своём соединении; остальные колонки, parts и local CAS сохраняет.
 * Переносимая версия пересчитывается, чтобы проверка достигала предметного декодера и guards.
 */
export function corruptHistoryChildLink(
  db: ProjectDatabase,
  child: HistorySession,
  field: "parentSessionId" | "originCheckpointId",
  value: string | null,
): void {
  const corrupted = { ...child, data: { ...child.data, [field]: value } };
  const primary = portableEntity(splitComponentRecord(corrupted).record);
  const column = field === "parentSessionId" ? "parent_session_id" : "origin_checkpoint_id";
  withExternalHistoryWrite(db, (raw) => {
    if (value === null) {
      raw.exec("PRAGMA ignore_check_constraints=ON");
    }
    const result = raw
      .query<{ id: string; link: string | null }, [string | null, string]>(
        `UPDATE work_sessions SET ${column}=? WHERE id=? RETURNING id,${column} AS link`,
      )
      .get(value, child.id);
    if (result?.id !== child.id || result.link !== value) {
      throw new Error("Не найдена физическая строка ребёнка для повреждения");
    }
    raw
      .query("UPDATE replication_entity_versions SET version=?,parents_json='[]' WHERE entity_id=?")
      .run(primary.version, child.id);
    raw.exec("UPDATE project_state SET generation=generation+1 WHERE singleton=1");
  });
}
