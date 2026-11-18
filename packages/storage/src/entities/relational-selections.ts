import type { ComponentKind, EntityKind } from "@relay/contracts";
import { ENTITY_DEFINITIONS } from "../relational/entity-definitions";
import { COMPONENT_DEFINITIONS } from "../relational/component-definitions";
import type { ColumnDefinition } from "../relational/columns.types";

/**
 * Возвращает JSON-строку строкового поля из его единственного физического источника.
 * Имена поступают из закрытого описания схемы; неизвестное или нестроковое поле не совпадает.
 */
function entityStringField(kind: EntityKind, field: string): string | undefined {
  const columns: readonly ColumnDefinition[] = ENTITY_DEFINITIONS[kind].columns;
  const definition = columns.find((entry) => entry.field === field);
  if (definition !== undefined) {
    if (definition.storage === "text") {
      return `coalesce(r.${definition.column}_json,json_quote(r.${definition.column}))`;
    }
    return definition.storage === "string" ? `json_quote(r.${definition.column})` : undefined;
  }
  if (kind === "application") {
    if (field === "boardId" || field === "prefix") {
      const column = field === "boardId" ? "id" : "prefix";
      return `(SELECT json_quote(${column}) FROM boards WHERE application_id=r.id)`;
    }
  }
  if (kind === "implementation") {
    switch (field) {
      case "featureId":
        return "json_quote(coalesce(r.feature_id,(SELECT feature_id FROM scenarios WHERE id=r.scenario_id)))";
      case "scenarioId":
        return "json_quote(r.scenario_id)";
      case "targetId":
        return "json_quote(coalesce(r.feature_id,r.scenario_id))";
      case "targetKind":
        return "json_quote(CASE WHEN r.feature_id IS NULL THEN 'scenario' ELSE 'feature' END)";
    }
  }
  if (kind === "work-session" && field === "currentRunId") {
    return "(SELECT json_quote(id) FROM session_runs WHERE owner_id=r.id AND state='active' AND deleted=0)";
  }
  return undefined;
}

/**
 * Строит предикат ID по известной колонке без построения полного raw data.
 * Единственный SQL-параметр — JSON-массив JSON-строк искомых значений, сохраняющий точные UTF-16 units.
 * Алиас e принадлежит запросу владельца; пользовательское имя поля не попадает в SQL.
 */
export function entityFieldFilter(kind: EntityKind, field: string): string {
  const value = entityStringField(kind, field);
  if (value === undefined) {
    return "e.id IN (SELECT value FROM json_each(?) WHERE 0)";
  }
  return `e.id IN (SELECT r.id FROM ${ENTITY_DEFINITIONS[kind].table} r
    WHERE ${value} IN (SELECT value FROM json_each(?)))`;
}

const arrayComponents = new Map<string, ComponentKind>([
  ["task:acceptanceCriteria", "task-criterion"],
  ["work-plan:stages", "plan-stage"],
  ["work-plan:scope", "plan-scope"],
  ["document:relations", "document-relation"],
  ["work-session:runs", "session-run"],
  ["project:documentSections", "document-section"],
]);

/**
 * Выбирает строковое верхнеуровневое поле объекта части без построения его полного value.
 * Собственные scoped ID и ключ участия имеют явные физические источники.
 */
function componentStringField(kind: ComponentKind, field: string): string | undefined {
  if (
    field === "id" &&
    ["task-criterion", "plan-stage", "session-run", "document-section"].includes(kind)
  ) {
    return "json_quote(r.id)";
  }
  if (kind === "session-run" && field === "key") {
    return "json_quote('RUN-'||r.id)";
  }
  const columns: readonly ColumnDefinition[] = COMPONENT_DEFINITIONS[kind].columns;
  const definition = columns.find((entry) => entry.field === field && !entry.field.includes("."));
  if (definition?.storage === "text") {
    return `coalesce(r.${definition.column}_json,json_quote(r.${definition.column}))`;
  }
  return definition?.storage === "string" ? `json_quote(r.${definition.column})` : undefined;
}

/**
 * Строит точный array-item предикат по typed колонкам; один параметр содержит JSON искомой строки.
 * Имена полей буквальные. Неизвестные поля и нестроковые значения дают пустую выборку.
 */
export function entityArrayItemFilter(
  kind: EntityKind,
  arrayField: string,
  itemField: string,
): string {
  const componentKind = arrayComponents.get(`${kind}:${arrayField}`);
  if (componentKind !== undefined) {
    const value = componentStringField(componentKind, itemField);
    if (value !== undefined) {
      return `e.id IN (SELECT r.owner_id FROM ${COMPONENT_DEFINITIONS[componentKind].table} r
        WHERE r.deleted=0 AND ${value}=?
          AND EXISTS(SELECT 1 FROM component_collections declaration
            WHERE declaration.owner_id=r.owner_id AND declaration.field='${arrayField}'
              AND declaration.deleted=0))`;
    }
  }
  if (kind === "work-checkpoint" && arrayField === "references") {
    const columns = new Map([
      ["id", "json_quote(r.target_id)"],
      ["kind", "json_quote(r.target_kind)"],
      ["key", "json_quote(r.snapshot_key)"],
      ["title", "coalesce(r.snapshot_title_json,json_quote(r.snapshot_title))"],
    ]);
    const value = columns.get(itemField);
    if (value !== undefined) {
      return `e.id IN (SELECT r.checkpoint_id FROM checkpoint_references r WHERE ${value}=?)`;
    }
  }
  return "e.id IN (SELECT value FROM json_each(?) WHERE 0)";
}
