import type { Database } from "bun:sqlite";
import type { CommandSelector } from "@relay/contracts";
import type { EntityIdentityWithRevision } from "../entities/entity-queries.types";
import { entityArrayItemFilter, entityFieldFilter } from "../entities/relational-selections";

/**
 * Выбирает полный состав по одному буквальному строковому полю и множеству его значений.
 * Один SQL независимо от числа значений; JSON-параметры сохраняют точный текст без JSON-path синтаксиса.
 * Пустой набор не обращается к SQL; тела совпавших карточек загружает вызывающий адресным getEntities.
 */
export function commandFieldSet(
  connection: Database,
  selector: Extract<CommandSelector, { kind: "field-set" }>,
): EntityIdentityWithRevision[] {
  if (selector.values.length === 0) {
    return [];
  }
  return connection
    .query<EntityIdentityWithRevision, [string]>(
      `
    SELECT e.id,e.kind,e.key,e.revision FROM entity_identities e
    WHERE ${entityFieldFilter(selector.entityKind, selector.field)} ORDER BY e.key,e.id
  `,
    )
    .all(JSON.stringify([...new Set(selector.values)].map((value) => JSON.stringify(value))));
}

/**
 * Возвращает точный состав планов выбранной задачи без декодирования их содержания.
 * Включения читаются по индексу первичной plan_tasks, без построения полного плана.
 */
export function commandMemberships(
  connection: Database,
  taskId: string,
): EntityIdentityWithRevision[] {
  return connection
    .query<EntityIdentityWithRevision, [string]>(
      `
    SELECT e.id,e.kind,e.key,e.revision FROM entity_identities e
    WHERE e.id IN (SELECT owner_id FROM plan_tasks WHERE task_id=? AND deleted=0)
    ORDER BY e.key,e.id
  `,
    )
    .all(taskId);
}

/**
 * Выбирает владельцев точного array-item предиката без тел и журналов.
 * Проверка отрицания и положительного множества выполняется одной и той же SQL-проекцией.
 */
export function commandArrayItems(
  connection: Database,
  selector: Extract<CommandSelector, { kind: "array-item" }>,
): EntityIdentityWithRevision[] {
  return connection
    .query<EntityIdentityWithRevision, [string]>(
      `
    SELECT e.id,e.kind,e.key,e.revision FROM entity_identities e
    WHERE ${entityArrayItemFilter(selector.entityKind, selector.arrayField, selector.itemField)}
    ORDER BY e.key,e.id
  `,
    )
    .all(JSON.stringify(selector.value));
}
