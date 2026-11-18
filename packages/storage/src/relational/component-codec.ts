import {
  isComponentValue,
  hasConsistentComponentId,
  isComponentPosition,
  isPortableVersionParents,
  type PortableComponent,
  type ComponentKind,
  type EntityKind,
} from "@relay/contracts";
import { COMPONENT_DEFINITIONS } from "./component-definitions";
import {
  assertKnownFields,
  decodeColumns,
  encodeColumns,
  identityText,
  invalidRow,
} from "./columns";
import type { SqlRow } from "./columns.types";

/**
 * Разлагает проверяемую часть на скалярные колонки конкретной таблицы.
 * targetKind нужен лишь у task-target: PortableComponent содержит только UUID цели.
 */
export function encodeComponentRow(component: PortableComponent, targetKind?: EntityKind): SqlRow {
  if (
    !isComponentValue(component.kind, component.value) ||
    !hasConsistentComponentId(component) ||
    !isComponentPosition(component.position) ||
    !isPortableVersionParents(component.parents)
  ) {
    invalidRow("component");
  }
  let value: Readonly<Record<string, unknown>> = component.value;
  if (component.kind === "session-run") {
    if (component.value.key !== `RUN-${component.id}`) {
      invalidRow("run.key");
    }
    if (component.value.operator !== null) {
      assertKnownFields({ ...component.value.operator }, [], ["name", "email", "source"]);
    }
    value = {
      ...component.value,
      operator: component.value.operator ?? { name: null, email: null, source: null },
    };
  }
  const row: SqlRow = {
    owner_id: identityText(component.ownerId, "ownerId"),
    id: identityText(component.id, "component.id"),
    position: component.position,
    version: identityText(component.version, "component.version"),
    parents_json: JSON.stringify(component.parents),
    deleted: component.deleted ? 1 : 0,
    ...encodeColumns(COMPONENT_DEFINITIONS[component.kind].columns, value),
  };
  if (component.kind === "task-target") {
    const targetId = identityText(component.value.targetId, "targetId");
    if (targetKind !== "feature" && targetKind !== "scenario" && targetKind !== "implementation") {
      invalidRow("targetKind");
    }
    row.feature_id = targetKind === "feature" ? targetId : null;
    row.scenario_id = targetKind === "scenario" ? targetId : null;
    row.implementation_id = targetKind === "implementation" ? targetId : null;
  }
  if (component.kind === "address-assignment") {
    row.is_current = 0;
  }
  return row;
}

/**
 * Собирает PortableComponent из отдельной предметной строки, проверяя связь вида и значения.
 */
export function decodeComponentRow(kind: ComponentKind, row: Readonly<SqlRow>): PortableComponent {
  const value = decodeColumns(COMPONENT_DEFINITIONS[kind].columns, row);
  const id = identityText(row.id, "component.id");
  if (["task-criterion", "plan-stage", "session-run", "document-section"].includes(kind)) {
    value.id = id;
  }
  if (kind === "section-reservation") {
    value.sectionId = id;
  }
  if (kind === "task-target") {
    const targets = [row.feature_id, row.scenario_id, row.implementation_id].filter(
      (item) => item !== null,
    );
    if (targets.length !== 1) {
      invalidRow("task-target");
    }
    value.targetId = identityText(targets[0], "targetId");
  }
  if (kind === "session-run") {
    value.key = `RUN-${id}`;
    if (row.operator_source === null) {
      if (
        row.operator_name !== null ||
        row.operator_name_json !== null ||
        row.operator_email !== null ||
        row.operator_email_json !== null
      ) {
        invalidRow("operator");
      }
      value.operator = null;
    }
  }
  if (!isComponentValue(kind, value)) {
    invalidRow("component.value");
  }
  const parentsJson = identityText(row.parents_json, "parents_json");
  const parents: unknown = JSON.parse(parentsJson);
  if (
    !isPortableVersionParents(parents) ||
    (row.deleted !== 0 && row.deleted !== 1) ||
    !isComponentPosition(row.position)
  ) {
    invalidRow("component.metadata");
  }
  // isComponentValue проверяет закрытую пару kind/value до формирования объединения.
  const component = {
    id,
    ownerId: identityText(row.owner_id, "owner_id"),
    kind,
    position: row.position,
    version: identityText(row.version, "version"),
    parents,
    deleted: row.deleted === 1,
    value,
  } as PortableComponent;
  if (!hasConsistentComponentId(component)) {
    invalidRow("component.id");
  }
  return component;
}
