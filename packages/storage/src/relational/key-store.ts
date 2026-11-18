import type { Database } from "bun:sqlite";
import { componentAllocatedId, RelayError } from "@relay/contracts";
import { versionComponent } from "../components/component-store";
import { encodeComponentRow } from "./component-codec";
import { identityText } from "./columns";
import { insertSqlRow, requireRelationalImport, requireRelationalTransaction } from "./sql-write";
import type { CurrentKeyOptions } from "./write.types";
import { relationalMessages } from "./relational.messages";

/**
 * Создаёт только отсутствующее назначение адреса со стабильным ID эффекта либо новым UUID.
 * Переносимую версию вычисляет общий владелец versionComponent; mutation/outbox захватывает вызывающий.
 */
function ensureAddress(
  db: Database,
  ownerId: string,
  ref: string,
  options: CurrentKeyOptions,
): void {
  const existing = db
    .query<{ owner_id: string }, [string]>(
      "SELECT owner_id FROM object_keys WHERE ref=? AND deleted=0",
    )
    .get(ref);
  if (existing !== null) {
    if (existing.owner_id !== ownerId) {
      throw new RelayError("CONFLICT", relationalMessages.addressOccupied, 4, { ref, ownerId });
    }
    return;
  }
  if (options.create === false) {
    throw new RelayError("CORRUPT_DATA", relationalMessages.addressMissing, 1, { ref, ownerId });
  }
  const otherIdentity = db
    .query<{ id: string }, [string]>("SELECT id FROM object_ids WHERE id=?")
    .get(ref);
  if (otherIdentity !== null && otherIdentity.id !== ownerId) {
    throw new RelayError("CONFLICT", relationalMessages.addressOccupied, 4, { ref, ownerId });
  }
  const allocationId = options.allocationId;
  const id =
    allocationId === undefined
      ? crypto.randomUUID()
      : componentAllocatedId(allocationId, ownerId, "address-assignment", ref);
  const component = versionComponent({
    ownerId,
    id,
    kind: "address-assignment",
    position: "V",
    parents: [],
    deleted: false,
    value: { ref },
  });
  insertSqlRow(db, "object_keys", encodeComponentRow(component));
}

/**
 * Атомарно в области внешней транзакции назначает текущий ключ и сохраняет прежний адрес алиасом.
 * UUID владельца не меняется. create:false используется после exact component import.
 */
export function assignCurrentKey(
  db: Database,
  ownerId: string,
  key: string,
  options: CurrentKeyOptions = {},
): void {
  requireRelationalTransaction(db);
  identityText(ownerId, "ownerId");
  identityText(key, "key");
  if (key.length === 0 || key.includes(":")) {
    throw new RelayError("CONFLICT", relationalMessages.invalidKey, 4, { key });
  }
  ensureAddress(db, ownerId, ownerId, options);
  if (key !== ownerId) {
    ensureAddress(db, ownerId, key, options);
  }
  db.query("UPDATE object_keys SET is_current=0 WHERE owner_id=? AND is_current=1 AND ref!=?").run(
    ownerId,
    key,
  );
  db.query(
    "UPDATE object_keys SET is_current=1 WHERE owner_id=? AND ref=? AND deleted=0 AND is_current=0",
  ).run(ownerId, key);
}

/**
 * Освобождает только роль текущего ключа при технической перестановке; назначения и UUID сохраняются.
 * Отсутствие ownerIds означает всех владельцев, пустой массив — no-op.
 */
export function releaseCurrentKeys(db: Database, ownerIds?: readonly string[]): void {
  requireRelationalImport(db);
  if (ownerIds === undefined) {
    db.exec("UPDATE object_keys SET is_current=0 WHERE is_current=1");
  } else if (ownerIds.length > 0) {
    for (const id of ownerIds) {
      identityText(id, "ownerId");
    }
    db.query(
      "UPDATE object_keys SET is_current=0 WHERE is_current=1 AND owner_id IN (SELECT value FROM json_each(?))",
    ).run(JSON.stringify(ownerIds));
  }
}

/**
 * Физически очищает выбранные адресные назначения только под technical import.
 * Вызывающий восстанавливает exact components и текущие роли до commit.
 */
export function clearObjectAddresses(db: Database, ownerIds?: readonly string[]): void {
  requireRelationalImport(db);
  if (ownerIds === undefined) {
    db.exec("DELETE FROM object_keys");
  } else if (ownerIds.length > 0) {
    for (const id of ownerIds) {
      identityText(id, "ownerId");
    }
    db.query("DELETE FROM object_keys WHERE owner_id IN (SELECT value FROM json_each(?))").run(
      JSON.stringify(ownerIds),
    );
  }
}
