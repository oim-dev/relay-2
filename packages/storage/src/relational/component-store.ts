import type { Database } from "bun:sqlite";
import type { EntityKind, PortableComponent } from "@relay/contracts";
import { COMPONENT_DEFINITIONS } from "./component-definitions";
import { encodeComponentRow } from "./component-codec";
import { requireRelationalTransaction, requireRelationalImport, upsertSqlRow } from "./sql-write";
import { identityText, invalidRow } from "./columns";

/**
 * Записывает exact PortableComponent в его предметную таблицу без вычисления новых ID/версий.
 * Предметные FK отложены до внешнего commit; вид разнородной цели task-target должен быть известен.
 * Повтор неизменённого upsert не обновляет строку. Current-role адреса задаётся отдельным key-store.
 */
export function upsertRelationalComponent(db: Database, component: PortableComponent): void {
  requireRelationalTransaction(db);
  let targetKind: EntityKind | undefined;
  if (component.kind === "task-target") {
    targetKind = db
      .query<{ kind: EntityKind }, [string]>("SELECT kind FROM object_ids WHERE id=?")
      .get(identityText(component.value.targetId, "targetId"))?.kind;
    if (targetKind === undefined) {
      invalidRow("targetId");
    }
  }
  const row = encodeComponentRow(component, targetKind);
  if (component.kind === "address-assignment" && component.deleted) {
    db.query("UPDATE object_keys SET is_current=0 WHERE owner_id=? AND id=? AND is_current=1").run(
      component.ownerId,
      component.id,
    );
  }
  upsertSqlRow(
    db,
    COMPONENT_DEFINITIONS[component.kind].table,
    row,
    ["owner_id", "id"],
    component.kind === "address-assignment" ? ["is_current"] : [],
  );
}

/**
 * Физически удаляет выбранную часть только в проверенном technical import; обычное снятие — tombstone.
 * Не удаляет другие назначения с совпадающей целью и не затрагивает числовой CAS владельца.
 */
export function removeRelationalComponent(
  db: Database,
  identity: Pick<PortableComponent, "ownerId" | "kind" | "id">,
): void {
  requireRelationalImport(db);
  identityText(identity.ownerId, "ownerId");
  identityText(identity.id, "component.id");
  db.query(
    `DELETE FROM ${COMPONENT_DEFINITIONS[identity.kind].table} WHERE owner_id=? AND id=?`,
  ).run(identity.ownerId, identity.id);
}
