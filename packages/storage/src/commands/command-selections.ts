import type { Database } from "bun:sqlite";
import {
  RelayError,
  type CommandEntityVersions,
  type CommandSelector,
  type EntityIdentity,
  type EntityRecord,
} from "@relay/contracts";
import {
  findAddressIdentities,
  getEntities,
  getEntity,
  getEntityIdentity,
  getEntitySummaries,
  listEntities,
  listEntitiesByField,
  listEntityIdentitiesByField,
  resolveEntityReferences,
  taskGraphRecords,
} from "../entities/entity-queries";
import type { EntityIdentityWithRevision } from "../entities/entity-queries.types";
import { readBatchReceipt } from "../batch/batch-receipts";
import { replicationFingerprint } from "../replication/portable-version";
import { previewCommandKey } from "./command-keys";
import { commandArrayItems, commandFieldSet, commandMemberships } from "./command-predicates";
import { commandStorageMessages } from "./command.messages";
import { readCommandVersions } from "./command-versions";
import type {
  CommandAddressRow,
  CommandSelection,
  CommandSelectionGuard,
} from "./command-selection.types";

/**
 * Формирует content guard состава, локального CAS и переносимой версии всего агрегата.
 * Для existence проверяется только привязка к ID/виду; комментарии не входят ни в один guard.
 */
function recordGuard(
  records: readonly EntityIdentityWithRevision[],
  selector: CommandSelector,
  versions: Readonly<Record<string, CommandEntityVersions>>,
): CommandSelectionGuard {
  if (selector.kind === "entity" && selector.semantic === "existence") {
    return existenceGuard([records[0] ?? null], selector.ref);
  }
  return {
    fingerprint: replicationFingerprint(
      records.map(({ id, revision }) => {
        const version = versions[id];
        if (version === undefined) {
          throw new RelayError("CORRUPT_DATA", commandStorageMessages.versionMissing, 1, { id });
        }
        return [id, revision, version.aggregateVersion];
      }),
    ),
    ids: records.map((record) => record.id),
    semantic: "content",
  };
}

/**
 * Проверяет только ref→ID/kind, сохраняя отрицания и порядок адресов.
 * Содержание и текущий ключ не входят в guard: rename с сохранённым alias оставляет ту же цель.
 */
function existenceGuard(
  identities: readonly (EntityIdentity | null)[],
  refs: string | readonly string[],
): CommandSelectionGuard {
  return {
    fingerprint: replicationFingerprint(
      identities.map((identity, index) => [
        typeof refs === "string" ? refs : refs[index],
        identity === null ? null : { id: identity.id, kind: identity.kind },
      ]),
    ),
    ids: identities.flatMap((identity) => (identity === null ? [] : [identity.id])),
    semantic: "existence",
  };
}

/**
 * Возвращает адресную проекцию вместе с независимой проверкой привязки.
 */
function identitySelection(
  identities: readonly (EntityIdentity | null)[],
  refs: string | readonly string[],
): CommandSelection {
  return {
    observation: { kind: "identities", identities },
    guard: existenceGuard(identities, refs),
  };
}

/**
 * Возвращает узкую техническую проекцию буквального адреса и истории его переназначения.
 */
function addressSelection(connection: Database, ref: string): CommandSelection {
  const row = connection
    .query<CommandAddressRow, [string, string, string]>(
      `
    SELECT (SELECT entity_id FROM entity_refs WHERE ref=?) AS currentId,
      (SELECT previous_id FROM replication_remapped_refs WHERE ref=?) AS previousId,
      (SELECT current_id FROM replication_remapped_refs WHERE ref=?) AS remappedId
  `,
    )
    .get(ref, ref, ref);
  // SELECT скалярных подзапросов всегда возвращает строку, даже для отсутствующего адреса.
  if (row === null) {
    throw new Error("COMMAND_ADDRESS_ROW_MISSING");
  }
  return {
    observation: { kind: "address-state", currentId: row.currentId, previousId: row.previousId },
    guard: {
      fingerprint: replicationFingerprint(row),
      ids: row.currentId === null ? [] : [row.currentId],
      semantic: "existence",
    },
  };
}

/**
 * Читает технические и идентификационные выборки сразу с guard без загрузки карточек.
 * undefined означает selector полных записей, обрабатываемый отдельной ветвью.
 */
function narrowSelection(
  connection: Database,
  selector: CommandSelector,
): CommandSelection | undefined {
  switch (selector.kind) {
    case "identities":
      return identitySelection(resolveEntityReferences(connection, selector.refs), selector.refs);
    case "virtual":
      return identitySelection(
        findAddressIdentities(connection, selector.ref, selector.entityKind),
        selector.ref,
      );
    case "array-item": {
      const records = commandArrayItems(connection, selector);
      const versions = readCommandVersions(
        connection,
        records.map((record) => record.id),
      );
      return {
        observation: { kind: "boolean", value: records.length > 0 },
        guard: recordGuard(records, selector, versions),
      };
    }
    case "key": {
      const observation = previewCommandKey(connection, selector);
      return {
        observation,
        guard: { fingerprint: replicationFingerprint(observation), ids: [], semantic: "existence" },
      };
    }
    case "address-state":
      return addressSelection(connection, selector.ref);
    case "receipt": {
      const observation = {
        kind: "receipt" as const,
        receipt: readBatchReceipt(connection, selector.operationKey) ?? null,
      };
      return {
        observation,
        guard: { fingerprint: replicationFingerprint(observation), ids: [], semantic: "existence" },
      };
    }
    default:
      return undefined;
  }
}

/**
 * Строит graph guard по узкой проекции обязательств; тексты и комментарии не читаются.
 */
function graphGuard(records: readonly EntityRecord[]): CommandSelectionGuard {
  return {
    fingerprint: replicationFingerprint(
      records.map((record) => ({ id: record.id, revision: record.revision, data: record.data })),
    ),
    ids: records.map((record) => record.id),
    semantic: "content",
  };
}

/**
 * Загружает ровно одну объявленную выборку синхронно внутри снимка владельца.
 * Обычные selectors не читают полный проект; граф использует специальную узкую проекцию.
 */
export function loadCommandSelection(
  connection: Database,
  selector: CommandSelector,
): CommandSelection {
  const narrow = narrowSelection(connection, selector);
  if (narrow !== undefined) {
    return narrow;
  }
  let records: EntityRecord[];
  switch (selector.kind) {
    case "summaries": {
      const summaries = getEntitySummaries(connection, selector.ids);
      const selected = summaries.filter((summary) => summary !== null);
      const versions = readCommandVersions(
        connection,
        selected.map((summary) => summary.id),
      );
      return {
        observation: { kind: "summaries", summaries, versions },
        guard: recordGuard(selected, selector, versions),
      };
    }
    case "entity": {
      const record = getEntity(connection, selector.ref, selector.entityKind);
      records = record === undefined ? [] : [record];
      break;
    }
    case "records":
      records = getEntities(connection, selector.ids, selector.entityKind);
      break;
    case "field":
      records = listEntitiesByField(
        connection,
        selector.entityKind,
        selector.field,
        selector.value,
      );
      break;
    case "field-set":
      records = getEntities(
        connection,
        commandFieldSet(connection, selector).map((record) => record.id),
        selector.entityKind,
      );
      break;
    case "kind":
      records = listEntities(connection, selector.entityKind);
      break;
    case "memberships":
      records = getEntities(
        connection,
        commandMemberships(connection, selector.taskId).map((record) => record.id),
        "work-plan",
      );
      break;
    case "task-graph":
      records = taskGraphRecords(connection);
      return { observation: { kind: "records", records }, guard: graphGuard(records) };
    default:
      throw new Error("COMMAND_SELECTOR_UNHANDLED");
  }
  const versions = readCommandVersions(
    connection,
    records.map((record) => record.id),
  );
  return {
    observation: { kind: "records", records, versions },
    guard: recordGuard(records, selector, versions),
  };
}

/**
 * Повторяет исходный предикат под замком commit, выбирая только идентичности и версии.
 * Полные тела field/kind/membership результатов и независимые журналы не перечитываются.
 */
export function readCommandGuard(
  connection: Database,
  selector: CommandSelector,
): CommandSelectionGuard {
  if (selector.kind === "entity" && selector.semantic === "existence") {
    return existenceGuard(
      [getEntityIdentity(connection, selector.ref, selector.entityKind) ?? null],
      selector.ref,
    );
  }
  if (selector.kind === "key") {
    try {
      const observation = previewCommandKey(connection, selector);
      return { fingerprint: replicationFingerprint(observation), ids: [], semantic: "existence" };
    } catch (error) {
      // Ранее доступный ключ мог стать недоступным из-за исчерпания counter конкурентом.
      if (error instanceof RelayError && error.code === "CONFLICT") {
        throw new RelayError("COMMAND_CONTEXT_CHANGED", commandStorageMessages.contextChanged, 4, {
          selector,
        });
      }
      throw error;
    }
  }
  const narrow = narrowSelection(connection, selector);
  if (narrow !== undefined) {
    return narrow.guard;
  }
  let records: EntityIdentityWithRevision[];
  switch (selector.kind) {
    case "entity":
      records = connection
        .query<EntityIdentityWithRevision, [string, string | null, string | null]>(
          `
        SELECT e.id,e.kind,e.key,e.revision FROM entity_refs r JOIN entities e ON e.id=r.entity_id
        WHERE r.ref=? AND (? IS NULL OR e.kind=?)
      `,
        )
        .all(selector.ref, selector.entityKind ?? null, selector.entityKind ?? null);
      break;
    case "summaries":
    case "records": {
      const entityKind = selector.kind === "records" ? (selector.entityKind ?? null) : null;
      records = connection
        .query<EntityIdentityWithRevision, [string, string | null, string | null]>(
          `
        SELECT e.id,e.kind,e.key,e.revision FROM json_each(?) requested JOIN entities e ON e.id=requested.value
        WHERE (? IS NULL OR e.kind=?) ORDER BY requested.key
      `,
        )
        .all(JSON.stringify(selector.ids), entityKind, entityKind);
      break;
    }
    case "field":
      records = listEntityIdentitiesByField(
        connection,
        selector.entityKind,
        selector.field,
        selector.value,
      );
      break;
    case "field-set":
      records = commandFieldSet(connection, selector);
      break;
    case "kind":
      records = connection
        .query<EntityIdentityWithRevision, [string]>(
          "SELECT id,kind,key,revision FROM entities WHERE kind=? ORDER BY key,id",
        )
        .all(selector.entityKind);
      break;
    case "memberships":
      records = commandMemberships(connection, selector.taskId);
      break;
    case "task-graph":
      return graphGuard(taskGraphRecords(connection));
    default:
      throw new Error("COMMAND_SELECTOR_UNHANDLED");
  }
  const versions = readCommandVersions(
    connection,
    records.map((record) => record.id),
  );
  return recordGuard(records, selector, versions);
}
