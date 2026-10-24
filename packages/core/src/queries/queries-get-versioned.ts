import {
  RelayError,
  type CommandEntityVersions,
  type CommandLoadResult,
  type CommandObservation,
  type CommandSelector,
  type CommandStore,
  type EntityIdentity,
  type EntityReadItem,
  type EntityReadOptions,
  type EntityReadResult,
  type EntityRecord,
  type KnowledgeRecord,
  type ProjectEntity,
  type VersionedEntityReadResult,
} from "@relay/contracts";
import { commandMessages } from "../commands/command.messages";
import { parseEntityReference } from "../entities/entity-addresses";
import { entityMessages } from "../entities/entity.messages";
import type { EntityReference } from "../entities/entity.types";
import { decodeKnowledge } from "../knowledge/knowledge-data";
import {
  indexDocumentSections,
  projectDocumentSection,
  type DocumentSectionIndex,
} from "../knowledge/document-sections";
import { decodeEntityRecord } from "../projections/entity-record";
import { decodeEntitySummary } from "../projections/entity-summary";
import { assembleReadItems, readAddressItem, selectedIds } from "./queries-get";

/**
 * Разбирает каждый уникальный адрес общим parser; ошибки и повторы сохраняют исходные позиции.
 */
function parseReadAddresses(refs: readonly string[]): EntityReadItem<EntityReference>[] {
  const parsed = new Map<string, EntityReadItem<EntityReference>>();
  return refs.map((ref) => {
    let item = parsed.get(ref);
    if (item === undefined) {
      item = readAddressItem(ref, () => parseEntityReference(ref));
      parsed.set(ref, item);
    }
    return item;
  });
}

/**
 * Принимает только объявленную идентификационную проекцию command port.
 */
function readIdentities(
  observation: CommandObservation | undefined,
): readonly (EntityIdentity | null)[] {
  if (observation?.kind !== "identities") {
    throw new RelayError("CORRUPT_DATA", commandMessages.observation);
  }
  return observation.identities;
}

/**
 * Выбирает буквальный адрес только ожидаемого вида; чужой вид допускает virtual fallback.
 */
function directIdentity(
  address: EntityReference,
  direct: ReadonlyMap<string, EntityIdentity | null>,
): EntityIdentity | undefined {
  const identity = direct.get(address.ref);
  return identity && (address.kind === undefined || identity.kind === address.kind)
    ? identity
    : undefined;
}

/**
 * Выбирает уникальные неразрешённые typed адреса досок и приложений без загрузки их содержания.
 */
function virtualSelectors(
  parsed: readonly EntityReadItem<EntityReference>[],
  direct: ReadonlyMap<string, EntityIdentity | null>,
): Extract<CommandSelector, { kind: "virtual" }>[] {
  const selectors = new Map<string, Extract<CommandSelector, { kind: "virtual" }>>();
  for (const item of parsed) {
    if (!item.ok || directIdentity(item.entity, direct) !== undefined) {
      continue;
    }
    const { ref, kind } = item.entity;
    if (kind === "board" || kind === "application") {
      selectors.set(item.ref, { kind: "virtual", ref, entityKind: kind });
    }
  }
  return [...selectors.values()];
}

/**
 * Разрешает адреса из загруженных фактов: прямые привязки приоритетны, virtual неоднозначность локальна.
 */
function resolveLoadedAddresses(
  parsed: readonly EntityReadItem<EntityReference>[],
  direct: ReadonlyMap<string, EntityIdentity | null>,
  virtual: ReadonlyMap<string, readonly (EntityIdentity | null)[]>,
): EntityReadItem<EntityIdentity>[] {
  const resolved = new Map<string, EntityReadItem<EntityIdentity>>();
  return parsed.map((item) => {
    if (!item.ok) {
      return item;
    }
    let address = resolved.get(item.ref);
    if (address === undefined) {
      address = readAddressItem(item.ref, () => {
        const { ref, kind } = item.entity;
        const directMatch = directIdentity(item.entity, direct);
        if (directMatch !== undefined) {
          return directMatch;
        }
        const matches = (virtual.get(item.ref) ?? []).filter((identity) => identity !== null);
        if (matches.length > 1) {
          throw new RelayError("CORRUPT_DATA", entityMessages.ambiguousAddress, 1, { ref, kind });
        }
        const identity = matches[0];
        if (identity !== undefined) {
          return identity;
        }
        throw new RelayError("NOT_FOUND", entityMessages.recordNotFound, 3, {
          ref,
          ...(kind === undefined ? {} : { kind }),
        });
      });
      resolved.set(item.ref, address);
    }
    return address;
  });
}

/**
 * Проверяет уже выбранные полные записи и строит effective-разделы без дополнительных чтений.
 * Проект и индекс разделов кешируются только на время этого снимка; ошибки остаются поэлементными.
 */
function decodeFullSelection(
  addresses: readonly EntityReadItem<EntityIdentity>[],
  records: readonly EntityRecord[],
  projectId: string,
): EntityReadItem<ProjectEntity>[] {
  const selected = new Map(records.map((record) => [record.id, record]));
  let decodedProject: KnowledgeRecord<"project"> | undefined;
  let sections: DocumentSectionIndex | undefined;

  /**
   * Лениво проверяет единственный backing project; известное отсутствие повторяет обычный get.
   */
  function project(): KnowledgeRecord<"project"> {
    const record = selected.get(projectId);
    if (record === undefined) {
      throw new RelayError("NOT_FOUND", entityMessages.recordNotFound, 3, {
        ref: projectId,
        kind: "project",
      });
    }
    return (decodedProject ??= decodeKnowledge(record, "project"));
  }

  /**
   * Применяет проекцию раздела после общего raw decoder и разделяет проверенный паспорт проекта.
   */
  function decode(record: EntityRecord): ProjectEntity {
    if (record.kind === "project" && record.id === projectId) {
      return project();
    }
    const entity = decodeEntityRecord(record, projectId);
    if (entity.kind !== "document") {
      return entity;
    }
    sections ??= indexDocumentSections(project());
    return projectDocumentSection(entity, sections);
  }

  return assembleReadItems(addresses, selected, decode);
}

/**
 * Собирает прежнее full/summary представление только из финального согласованного load.
 * Summary декодирует узкие поля, не обращаясь к полным карточкам или каталогу разделов.
 */
function decodeReadSelection(
  addresses: readonly EntityReadItem<EntityIdentity>[],
  loaded: CommandLoadResult,
  projectId: string,
  options: EntityReadOptions,
): VersionedEntityReadResult {
  const observation = loaded.observations[0];
  let data: EntityReadResult;
  if (options.summary && observation?.kind === "summaries") {
    const records = new Map(
      observation.summaries.filter((row) => row !== null).map((row) => [row.id, row]),
    );
    data = {
      view: "summary",
      generation: loaded.generation,
      items: assembleReadItems(addresses, records, decodeEntitySummary),
    };
  } else if (!options.summary && observation?.kind === "records") {
    data = {
      view: "full",
      generation: loaded.generation,
      items: decodeFullSelection(addresses, observation.records, projectId),
    };
  } else {
    throw new RelayError("CORRUPT_DATA", commandMessages.observation);
  }
  const versions = new Map<string, CommandEntityVersions>();
  for (const item of data.items) {
    if (!item.ok) {
      continue;
    }
    const version = observation.versions?.[item.entity.id];
    if (version === undefined) {
      throw new RelayError("CORRUPT_DATA", commandMessages.versionMetadata, 1, {
        id: item.entity.id,
      });
    }
    versions.set(item.entity.id, { ...version });
  }
  return { data, versions: Object.fromEntries(versions) };
}

/**
 * Читает ограниченный адресный набор через настоящую async границу command port.
 * Все загрузки используют исходный anchor; конкурентный commit даёт COMMAND_CONTEXT_CHANGED.
 * Full выбирает уникальные ID и backing project только для документов, summary — только узкую проекцию.
 * Форма запроса должна быть проверена вызывающим QueryService до первого I/O.
 */
export async function readVersionedEntitySelection(
  store: CommandStore,
  refs: readonly string[],
  options: EntityReadOptions,
): Promise<VersionedEntityReadResult> {
  const parsed = parseReadAddresses(refs);
  const rawRefs = [...new Set(parsed.flatMap((item) => (item.ok ? [item.entity.ref] : [])))];
  const initial = await store.load({
    anchor: null,
    selectors: [{ kind: "identities", refs: rawRefs }],
  });
  const identities = readIdentities(initial.observations[0]);
  if (identities.length !== rawRefs.length) {
    throw new RelayError("CORRUPT_DATA", commandMessages.observation);
  }
  const direct = new Map(rawRefs.map((ref, index) => [ref, identities[index] ?? null]));
  const selectors = virtualSelectors(parsed, direct);
  const virtual = new Map<string, readonly (EntityIdentity | null)[]>();
  if (selectors.length > 0) {
    const loaded = await store.load({ anchor: initial.anchor, selectors });
    selectors.forEach((selector, index) => {
      virtual.set(
        `${selector.entityKind}:${selector.ref}`,
        readIdentities(loaded.observations[index]),
      );
    });
  }
  const addresses = resolveLoadedAddresses(parsed, direct, virtual);
  const ids = new Set(selectedIds(addresses));
  if (!options.summary && addresses.some((item) => item.ok && item.entity.kind === "document")) {
    ids.add(store.projectId);
  }
  const loaded = await store.load({
    anchor: initial.anchor,
    selectors: [{ kind: options.summary ? "summaries" : "records", ids: [...ids] }],
  });
  return decodeReadSelection(addresses, loaded, store.projectId, options);
}
