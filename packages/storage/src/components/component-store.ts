import type { Database } from "bun:sqlite";
import {
  RelayError,
  componentCollection,
  componentIdentity,
  componentAllocatedId,
  componentNaturalIdentity,
  isComponentPosition,
  isComponentValue,
  hasConsistentComponentId,
  isPortableVersionParents,
  type PortableComponent,
  type ComponentLayout,
  type ComponentKind,
} from "@relay/contracts";
import { canonicalJson, replicationFingerprint } from "../replication/portable-version";
import { assignComponentPositions } from "./component-positions";
import type {
  ComponentRow,
  ComponentStorageEntry,
  ComponentWriteOptions,
} from "./component-store.types";
import { componentStorageMessages } from "./component.messages";
import { assertSqlReferences, assertSqlText } from "../entities/entity-sql-text";
import {
  removeRelationalComponent,
  upsertRelationalComponent,
} from "../relational/component-store";
import { captureComponentChange, isReplicationImport } from "../replication/replication-capture";

/**
 * Декодирует primary SQL part; неверная форма не превращается в пустую коллекцию.
 * Все части, включая адреса, обязаны иметь окончательную проверяемую версию.
 */
export function decodeComponentRow(row: ComponentRow): PortableComponent {
  const value: unknown = JSON.parse(row.value);
  const parents: unknown = JSON.parse(row.parents_json);
  if (
    !isComponentValue(row.kind, value) ||
    !isComponentPosition(row.position) ||
    !isPortableVersionParents(parents) ||
    ![0, 1].includes(row.deleted)
  ) {
    throw new RelayError("CORRUPT_DATA", componentStorageMessages.shape, 1, {
      ownerId: row.owner_id,
      kind: row.kind,
      id: row.id,
    });
  }
  // kind/value проверены isComponentValue; SQL ограничивает kind закрытым набором.
  const component = {
    id: row.id,
    kind: row.kind,
    ownerId: row.owner_id,
    position: row.position,
    version: row.version,
    parents,
    deleted: row.deleted === 1,
    value,
  } as PortableComponent;
  if (
    !hasConsistentComponentId(component) ||
    row.identity_key !== componentSqlIdentity(component) ||
    row.group_id !== (component.kind === "plan-task" ? component.value.stageId : "") ||
    versionComponent(component).version !== component.version
  ) {
    throw new RelayError("CORRUPT_DATA", componentStorageMessages.shape, 1, {
      ownerId: row.owner_id,
      kind: row.kind,
      id: row.id,
    });
  }
  return component;
}

/**
 * Читает parts одним SQL-запросом для всего снимка либо только выбранных owners, включая tombstones.
 * Пустой пакет owners ничего не загружает; public hydration использует этот путь без N+1.
 */
export function readComponents(
  connection: Database,
  ownerIds?: readonly string[],
): PortableComponent[] {
  if (ownerIds !== undefined) {
    assertSqlReferences(ownerIds);
  }
  if (ownerIds?.length === 0) {
    return [];
  }
  const rows =
    ownerIds === undefined
      ? connection
          .query<ComponentRow, []>("SELECT * FROM entity_components ORDER BY owner_id,kind,id")
          .all()
      : connection
          .query<ComponentRow, [string]>(
            `SELECT * FROM entity_components WHERE owner_id IN (SELECT value FROM json_each(?))
             ORDER BY owner_id,kind,id`,
          )
          .all(JSON.stringify([...new Set(ownerIds)]));
  return rows.map(decodeComponentRow);
}

/**
 * Вычисляет независимую переносимую версию из точной части и её непосредственных предков.
 */
export function versionComponent(component: Omit<PortableComponent, "version">): PortableComponent {
  const payload = {
    id: component.id,
    kind: component.kind,
    ownerId: component.ownerId,
    position: component.position,
    parents: [...new Set(component.parents)].sort(),
    deleted: component.deleted,
    value: component.value,
  };
  return { ...payload, version: replicationFingerprint(payload) } as PortableComponent;
}

/**
 * Сохраняет часть через её typed таблицу и захватывает точную дельту в той же транзакции.
 * Неизменённая часть не записывается; relational constraints защищают identity/history.
 */
export function persistComponent(connection: Database, entry: ComponentStorageEntry): void {
  const part = entry.component;
  assertComponentSqlText(part);
  assertSqlText(entry.group, "component.group");
  const identity =
    part.kind === "plan-participant" ? JSON.stringify(entry.identity) : entry.identity;
  assertSqlText(identity, "component.identity");
  if (isReplicationImport(connection)) {
    upsertRelationalComponent(connection, part);
    return;
  }
  let before = entry.before;
  if (before === undefined) {
    const row = connection
      .query<ComponentRow, [string, string, string]>(
        `SELECT c.* FROM entity_components c
         WHERE c.owner_id=? AND c.kind=? AND c.id=?`,
      )
      .get(part.ownerId, part.kind, part.id);
    before = row === null ? null : decodeComponentRow(row);
  }
  if (before !== null && canonicalJson(before) === canonicalJson(part)) {
    return;
  }
  upsertRelationalComponent(connection, part);
  captureComponentChange(connection, before, part);
}

/**
 * JSON-имена участников не становятся lossy plainTEXT: индекс хранит их JSON-string key.
 * Идентичности остальных видов должны быть wellformed до SQL binding.
 */
function componentSqlIdentity(component: PortableComponent): string {
  const identity = componentNaturalIdentity(component);
  return component.kind === "plan-participant" ? JSON.stringify(identity) : identity;
}

/**
 * Проверяет лишь plain SQL identity поля; тела/названия в value сохраняются JSON escape.
 */
function assertComponentSqlText(
  component: Pick<PortableComponent, "id" | "ownerId" | "kind">,
): void {
  assertSqlText(component.id, "component.id");
  assertSqlText(component.ownerId, "component.ownerId");
  assertSqlText(component.kind, "component.kind");
}

/**
 * Группирует части по области пользовательского порядка; адресам/декларациям он не требуется.
 */
function orderingGroup(kind: ComponentKind, group: string): string {
  return JSON.stringify([kind, group]);
}

/**
 * Атомарно синхронизирует первичные parts из уже проверенного агрегатного результата Core.
 * Новый UUID появляется лишь у нового включения без старого ID; no-op не меняет его version/position.
 * Неверная форма коллекции отклоняется до записи: универсального raw fallback в typed схеме нет.
 */
export function synchronizeComponents(
  connection: Database,
  layout: ComponentLayout,
  options: ComponentWriteOptions = {},
): void {
  if (layout.malformed.length > 0) {
    throw new RelayError("CORRUPT_DATA", componentStorageMessages.shape, 1, {
      ownerId: layout.record.id,
      fields: layout.malformed,
    });
  }
  const old = readComponents(connection, [layout.record.id]);
  const active = new Map(
    old
      .filter((part) => !part.deleted)
      .map((part) => [JSON.stringify([part.kind, componentNaturalIdentity(part)]), part]),
  );
  const all = new Map(old.map((part) => [componentIdentity(part), part]));
  const drafts = layout.seeds.map((item) => {
    const previous = active.get(JSON.stringify([item.kind, item.identity]));
    const allocated =
      options.allocationId === undefined
        ? undefined
        : componentAllocatedId(options.allocationId, layout.record.id, item.kind, item.identity);
    const id = item.id ?? previous?.id ?? allocated ?? crypto.randomUUID();
    const key = componentIdentity({ ownerId: layout.record.id, kind: item.kind, id });
    const prior = previous ?? all.get(key);
    if (prior?.deleted && item.kind !== "collection") {
      throw new RelayError("COMPONENT_RETIRED", componentStorageMessages.retired, 4, {
        ownerId: layout.record.id,
        kind: item.kind,
        id,
      });
    }
    return { item, id, prior, key };
  });
  const groups = new Map<string, typeof drafts>();
  for (const draft of drafts) {
    const key = orderingGroup(draft.item.kind, draft.item.group);
    const values = groups.get(key) ?? [];
    values.push(draft);
    groups.set(key, values);
  }
  const positions = new Map<string, string>();
  for (const values of groups.values()) {
    const existing = values.flatMap((draft) => (draft.prior === undefined ? [] : [draft.prior]));
    const assigned = assignComponentPositions(
      values.map((draft) => draft.id),
      existing,
    );
    for (const draft of values) {
      const position = draft.item.kind === "collection" ? "V" : assigned.get(draft.id);
      if (position === undefined) {
        throw new Error("COMPONENT_POSITION_MISSING");
      }
      positions.set(draft.key, position);
    }
  }
  const desired = new Set(drafts.map((draft) => draft.key));
  for (const previous of old) {
    const field = componentCollection(previous);
    if (previous.deleted || field === null || desired.has(componentIdentity(previous))) {
      continue;
    }
    persistComponent(connection, {
      component: versionComponent({ ...previous, deleted: true, parents: [previous.version] }),
      identity: componentNaturalIdentity(previous),
      group: previous.kind === "plan-task" ? previous.value.stageId : "",
      before: previous,
    });
  }
  for (const draft of drafts) {
    const position = positions.get(draft.key);
    if (position === undefined) {
      throw new Error("COMPONENT_POSITION_MISSING");
    }
    if (
      draft.prior !== undefined &&
      !draft.prior.deleted &&
      draft.prior.position === position &&
      canonicalJson(draft.prior.value) === canonicalJson(draft.item.value)
    ) {
      continue;
    }
    const component = versionComponent({
      id: draft.id,
      kind: draft.item.kind,
      ownerId: layout.record.id,
      position,
      deleted: false,
      parents: draft.prior === undefined ? [] : [draft.prior.version],
      value: draft.item.value,
    } as Omit<PortableComponent, "version">);
    persistComponent(connection, {
      component,
      identity: draft.item.identity,
      group: draft.item.group,
      before: draft.prior ?? null,
    });
  }
}

/**
 * Импортирует точные IDs/versions/positions проверенного Core снимка; importing=1 обязателен.
 * ownerIds ограничивает замену; отсутствие означает полный компонентный снимок проекта.
 * Omitted rows удаляются лишь в техническом импорте (Core проверяет сохранение опубликованных tombstones).
 */
export function replaceComponents(
  connection: Database,
  components: readonly PortableComponent[],
  ownerIds?: readonly string[],
): void {
  requireComponentImport(connection);
  const allowed = ownerIds === undefined ? undefined : new Set(ownerIds);
  const identities = validateComponentUpserts(components);
  for (const part of components) {
    if (allowed !== undefined && !allowed.has(part.ownerId)) {
      throw new RelayError("CORRUPT_DATA", componentStorageMessages.snapshot, 1);
    }
  }
  const removed = readComponents(connection, ownerIds).filter(
    (part) => !identities.has(componentIdentity(part)),
  );
  applyComponentImportDelta(connection, components, removed);
}

/**
 * Определяет запись, освобождающую уникальное действующее назначение перед следующими upserts.
 * Завершённый session-run остаётся immutable историей с deleted=false, но освобождает active-слот owner.
 */
function releasesComponentSlot(component: PortableComponent): boolean {
  return (
    component.deleted || (component.kind === "session-run" && component.value.state !== "active")
  );
}

/**
 * Применяет только заранее рассчитанные exact upserts/removals под importing=1 и внешней transaction.
 * Не сканирует owners/весь проект, не создаёт IDs/версии. Повтор неизменённого upsert не пишет строку.
 * Tombstones и завершения session-run идут первыми, освобождая unique-слоты до новых назначений.
 */
export function applyComponentImportDelta(
  connection: Database,
  upserts: readonly PortableComponent[],
  removed: readonly Pick<PortableComponent, "ownerId" | "kind" | "id">[],
): void {
  requireComponentImport(connection);
  const identities = validateComponentUpserts(upserts);
  const removedIds = new Set<string>();
  for (const part of removed) {
    assertComponentSqlText(part);
    const key = componentIdentity(part);
    if (identities.has(key) || removedIds.has(key)) {
      throw new RelayError("CORRUPT_DATA", componentStorageMessages.snapshot, 1);
    }
    removedIds.add(key);
  }
  for (const part of removed) {
    removeRelationalComponent(connection, part);
  }
  for (const part of [
    ...upserts.filter(releasesComponentSlot),
    ...upserts.filter((entry) => !releasesComponentSlot(entry)),
  ]) {
    persistComponent(connection, {
      component: part,
      identity: componentNaturalIdentity(part),
      group: part.kind === "plan-task" ? part.value.stageId : "",
    });
  }
}

/**
 * Проверяет техническое владение импортом; без внешней transaction частичная запись запрещена.
 */
function requireComponentImport(connection: Database): void {
  const state = connection
    .query<{ importing: number }, []>("SELECT importing FROM replication_state WHERE singleton=1")
    .get();
  if (!connection.inTransaction || state?.importing !== 1) {
    throw new RelayError("TRANSACTION_REQUIRED", componentStorageMessages.importRequired, 4);
  }
}

/**
 * Проверяет весь набор до первой записи, включая canonical parents, scoped ID и точный hash.
 */
function validateComponentUpserts(components: readonly PortableComponent[]): Set<string> {
  const identities = new Set<string>();
  for (const part of components) {
    assertComponentSqlText(part);
    const key = componentIdentity(part);
    if (
      !isComponentValue(part.kind, part.value) ||
      !hasConsistentComponentId(part) ||
      !isComponentPosition(part.position) ||
      !isPortableVersionParents(part.parents) ||
      identities.has(key) ||
      versionComponent(part).version !== part.version
    ) {
      throw new RelayError("CORRUPT_DATA", componentStorageMessages.snapshot, 1);
    }
    assertSqlText(componentSqlIdentity(part), "component.identity");
    if (part.kind === "plan-task") {
      assertSqlText(part.value.stageId, "component.group");
    }
    identities.add(key);
  }
  return identities;
}
