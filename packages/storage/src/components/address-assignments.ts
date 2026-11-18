import type { Database } from "bun:sqlite";
import { componentAllocatedId, type EntityIdentity } from "@relay/contracts";
import { persistComponent, versionComponent } from "./component-store";
import type { ComponentWriteOptions } from "./component-store.types";
import { assertSqlText } from "../entities/entity-sql-text";

/**
 * Создаёт отсутствующие назначения постоянного ID и текущего читаемого ключа.
 * Прежние назначения остаются aliases; чужой адрес отклоняет уникальность typed таблицы.
 * ID части выделяется из точного command effect либо UUID обычного локального writer.
 * Транзакцией и выбором current key владеет вызывающий; функция не изменяет ревизию owner.
 */
export function ensureEntityAddresses(
  connection: Database,
  entity: EntityIdentity,
  options: ComponentWriteOptions,
): void {
  if (options.allocationId !== undefined) {
    assertSqlText(options.allocationId, "allocationId");
  }
  const find = connection.query<{ entity_id: string }, [string]>(
    "SELECT entity_id FROM entity_refs WHERE ref=?",
  );
  for (const ref of new Set([entity.id, entity.key])) {
    if (find.get(ref)?.entity_id === entity.id) {
      continue;
    }
    const id =
      options.allocationId === undefined
        ? crypto.randomUUID()
        : componentAllocatedId(options.allocationId, entity.id, "address-assignment", ref);
    persistComponent(connection, {
      component: versionComponent({
        id,
        kind: "address-assignment",
        ownerId: entity.id,
        position: "V",
        parents: [],
        deleted: false,
        value: { ref },
      }),
      identity: ref,
      group: "",
      before: null,
    });
  }
}
