import type { Database } from "bun:sqlite";
import type { CommandSelector, EntityKind } from "@relay/contracts";
import type { EntityIdentityWithRevision } from "../entities/entity-queries.types";

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
    .query<EntityIdentityWithRevision, [EntityKind, string, string]>(
      `
    SELECT e.id,e.kind,e.key,e.revision FROM entities e WHERE e.kind=? AND EXISTS (
      SELECT 1 FROM json_each(e.data) field
      WHERE field.key=json_extract(?,'$') AND field.type='text'
        AND field.value IN (SELECT value FROM json_each(?) WHERE type='text')
    ) ORDER BY e.key,e.id
  `,
    )
    .all(
      selector.entityKind,
      JSON.stringify(selector.field),
      JSON.stringify([...new Set(selector.values)]),
    );
}

/**
 * Возвращает точный состав планов выбранной задачи без декодирования их содержания.
 * Нормализованные включения читаются по индексу; legacy/malformed JSON остаётся видимым декодеру.
 */
export function commandMemberships(
  connection: Database,
  taskId: string,
): EntityIdentityWithRevision[] {
  return connection
    .query<EntityIdentityWithRevision, [string, string]>(
      `
    SELECT e.id,e.kind,e.key,e.revision FROM entities e WHERE e.kind='work-plan' AND (
      EXISTS(SELECT 1 FROM entity_components c WHERE c.owner_id=e.id
        AND c.kind='plan-task' AND c.deleted=0 AND json_extract(c.value,'$.taskId')=?)
      OR EXISTS(SELECT 1 FROM json_each(CASE WHEN json_type(e.data,'$.stages')='array'
          THEN json_extract(e.data,'$.stages') ELSE '[]' END) stage
        JOIN json_each(CASE WHEN json_type(CASE WHEN stage.type='object' THEN stage.value ELSE '{}' END,'$.taskIds')='array'
          THEN json_extract(stage.value,'$.taskIds') ELSE '[]' END) task
        WHERE task.type='text' AND task.value=?)
    ) ORDER BY e.key,e.id
  `,
    )
    .all(taskId, taskId);
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
    .query<
      EntityIdentityWithRevision,
      [EntityKind, string, string, string, string, string, string]
    >(
      `
    SELECT e.id,e.kind,e.key,e.revision FROM entities e WHERE e.kind=? AND (
      EXISTS(SELECT 1 FROM entity_components c JOIN json_each(c.value) field
        WHERE c.owner_id=e.id AND c.deleted=0 AND c.kind=CASE ?
          WHEN 'acceptanceCriteria' THEN 'task-criterion' WHEN 'stages' THEN 'plan-stage'
          WHEN 'scope' THEN 'plan-scope' WHEN 'relations' THEN 'document-relation'
          WHEN 'runs' THEN 'session-run' WHEN 'documentSections' THEN 'document-section' END
          AND field.key=? AND field.type='text' AND field.value=?)
      OR EXISTS(SELECT 1 FROM json_each(e.data) array_field
        JOIN json_each(CASE WHEN array_field.type='array' THEN array_field.value ELSE '[]' END) item
        JOIN json_each(CASE WHEN item.type='object' THEN item.value ELSE '{}' END) item_field
        WHERE array_field.key=? AND item_field.key=? AND item_field.type='text' AND item_field.value=?)
    ) ORDER BY e.key,e.id
  `,
    )
    .all(
      selector.entityKind,
      selector.arrayField,
      selector.itemField,
      selector.value,
      selector.arrayField,
      selector.itemField,
      selector.value,
    );
}
