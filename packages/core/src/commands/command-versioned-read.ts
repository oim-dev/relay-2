import {
  RelayError,
  type CommandLoadResult,
  type CommandStore,
  type EntityKind,
  type VersionedCommandEntity,
} from "@relay/contracts";
import { parseEntityReference } from "../entities/entity-addresses";
import { decodeEntityRecord } from "../projections/entity-record";
import { commandMessages } from "./command.messages";

/**
 * Извлекает одну полную запись вместе с version metadata того же snapshot, без self-reference в data.
 */
function decodedVersionedResult(
  result: CommandLoadResult,
  projectId: string,
): VersionedCommandEntity | undefined {
  const observation = result.observations[0];
  if (observation?.kind !== "records") {
    throw new RelayError("CORRUPT_DATA", commandMessages.observation);
  }
  const record = observation.records[0];
  if (record === undefined) {
    return undefined;
  }
  const versions = observation.versions?.[record.id];
  if (versions === undefined) {
    throw new RelayError("CORRUPT_DATA", commandMessages.versionMetadata, 1, { id: record.id });
  }
  return { entity: decodeEntityRecord(record, projectId), versions: { ...versions } };
}

/**
 * Читает агрегат и переносимый aggregateVersion для последующего NamedCommand.expectedVersion.
 * Адресация, содержание и версии относятся к одному anchor; чтение remapped адреса разрешено.
 * Журнал задачи включён в entity, но не в content token. Документ сохраняет raw sectionId;
 * обычные readonly сервисы и их синхронные UI-проекции этим API не заменяются.
 */
export async function readVersionedEntity(
  store: CommandStore,
  input: string,
  expectedKind?: EntityKind,
): Promise<VersionedCommandEntity> {
  const { ref, kind } = parseEntityReference(input, expectedKind);
  const loaded = await store.load({
    anchor: null,
    selectors: [{ kind: "entity", ref, ...(kind === undefined ? {} : { entityKind: kind }) }],
  });
  const direct = decodedVersionedResult(loaded, store.projectId);
  if (direct !== undefined) {
    return direct;
  }
  if (kind === "board" || kind === "application") {
    const virtual = await store.load({
      anchor: loaded.anchor,
      selectors: [{ kind: "virtual", ref, entityKind: kind }],
    });
    const observation = virtual.observations[0];
    if (observation?.kind !== "identities") {
      throw new RelayError("CORRUPT_DATA", commandMessages.observation);
    }
    const identities = observation.identities.filter((identity) => identity !== null);
    if (identities.length > 1) {
      throw new RelayError("CORRUPT_DATA", commandMessages.ambiguous, 1, { ref, kind });
    }
    const identity = identities[0];
    if (identity !== undefined) {
      const result = await store.load({
        anchor: loaded.anchor,
        selectors: [{ kind: "entity", ref: identity.id, entityKind: kind }],
      });
      const decoded = decodedVersionedResult(result, store.projectId);
      if (decoded !== undefined) {
        return decoded;
      }
    }
  }
  throw new RelayError("NOT_FOUND", commandMessages.missing, 3, { ref, kind });
}
