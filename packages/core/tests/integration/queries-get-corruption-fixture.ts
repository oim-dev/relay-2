import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { splitComponentRecord, type KnowledgeRecord } from "@relay/contracts";
import { portableEntity, type ProjectDatabase } from "@relay/storage";

/**
 * Имитирует внешнее повреждение ссылки документа на отсутствующий раздел.
 * Отдельное raw-соединение отключает FK только на время fixture и закрывается при любом исходе.
 * Локальный CAS, поколение и переносимая версия соответствуют повреждённой записи;
 * остальные поля и части сохраняются. Штатная запись такую ссылку отвергает.
 */
export function corruptDocumentSection(
  db: ProjectDatabase,
  document: KnowledgeRecord<"document">,
  sectionId: string,
): KnowledgeRecord<"document"> {
  const previous = db
    .captureReplication()
    .entities.find((entity) => entity.record.id === document.id);
  assert(previous);
  const corrupted: KnowledgeRecord<"document"> = {
    ...document,
    revision: document.revision + 1,
    data: { ...document.data, sectionId },
  };
  const versioned = portableEntity(splitComponentRecord(corrupted).record, [previous.version]);
  const raw = new Database(db.path, { strict: true });
  try {
    raw.exec("PRAGMA foreign_keys = OFF");
    raw
      .transaction(() => {
        assert(
          raw
            .query(
              `UPDATE local_entity_revisions SET revision=? WHERE entity_id=? AND revision=?
               RETURNING entity_id`,
            )
            .get(corrupted.revision, document.id, document.revision),
        );
        assert(
          raw
            .query("UPDATE documents SET section_id=? WHERE id=? RETURNING id")
            .get(sectionId, document.id),
        );
        assert(
          raw
            .query(
              `UPDATE replication_entity_versions SET version=?,parents_json=? WHERE entity_id=?
               RETURNING entity_id`,
            )
            .get(versioned.version, JSON.stringify(versioned.parents), document.id),
        );
        raw.exec("UPDATE project_state SET generation=generation+1 WHERE singleton=1");
        raw.exec("DELETE FROM replication_publications");
      })
      .immediate();
  } finally {
    raw.close();
  }
  return corrupted;
}
