import type { Database } from "bun:sqlite";
import { RelayError, type ReplicationChangeset } from "@relay/contracts";
import { replicationFingerprint } from "./portable-version";
import { storageReplicationMessages } from "./replication.messages";
import type { ReplicationJsonRow } from "./replication.types";
import type {
  ReplicationOutboxRequest,
  ReplicationOutboxSizeRow,
  ReplicationOutboxWindow,
  ReplicationSourceDigest,
  ReplicationDependencySource,
  ReplicationDependencyRow,
} from "./replication-outbox.types";

/**
 * Проверяет положительные конечные бюджеты до SQL; курсор не может быть отрицательным.
 */
function assertOutboxRequest(request: ReplicationOutboxRequest): void {
  if (
    !Number.isSafeInteger(request.afterSequence) ||
    request.afterSequence < 0 ||
    !Number.isSafeInteger(request.maxChangesets) ||
    request.maxChangesets < 1 ||
    request.maxChangesets >= Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(request.maxBytes) ||
    request.maxBytes < 1
  ) {
    throw new RelayError("INVALID_ARGUMENT", storageReplicationMessages.outboxBudget, 2);
  }
}

/**
 * Разбирает только выбранный исходный payload и проверяет неизменяемую контрольную сумму.
 */
export function decodeOutboxChangeset(row: ReplicationJsonRow): ReplicationChangeset {
  const changeset: ReplicationChangeset = JSON.parse(row.json);
  const { digest, ...payload } = changeset;
  if (replicationFingerprint(payload) !== digest) {
    throw new RelayError("CORRUPT_DATA", storageReplicationMessages.corruptChangeset, 1, {
      id: changeset.id,
    });
  }
  return changeset;
}

/**
 * Читает окно в snapshot вызывающего: count+1 размеров, один пакет payload и count(*) по индексу.
 * LIMIT применяется до JSON.parse/hash; большие тексты вне окна не передаются в JS.
 * Бюджет относится к source bytes, не к полному canonical snapshot/эффективным transitions.
 */
export function readOutboxWindow(
  connection: Database,
  request: ReplicationOutboxRequest,
): ReplicationOutboxWindow {
  assertOutboxRequest(request);
  const rows = connection
    .query<ReplicationOutboxSizeRow, [number, number]>(
      `SELECT id,sequence,octet_length(json) AS bytes FROM replication_outbox
       WHERE sequence>? ORDER BY sequence LIMIT ?`,
    )
    .all(request.afterSequence, request.maxChangesets + 1);
  const ids: string[] = [];
  let sourceBytes = 0;
  let lastSequence = 0;
  for (const row of rows) {
    if (
      ids.length === request.maxChangesets ||
      (ids.length > 0 && row.bytes > request.maxBytes - sourceBytes)
    ) {
      break;
    }
    ids.push(row.id);
    sourceBytes += row.bytes;
    lastSequence = row.sequence;
  }
  const changesets =
    ids.length === 0
      ? []
      : connection
          .query<ReplicationJsonRow, [string]>(
            `SELECT json FROM replication_outbox WHERE id IN (SELECT value FROM json_each(?))
             ORDER BY sequence`,
          )
          .all(JSON.stringify(ids))
          .map(decodeOutboxChangeset);
  const count = connection
    .query<{ pending: number }, []>("SELECT count(*) AS pending FROM replication_outbox")
    .get();
  if (count === null) {
    throw new RelayError("DATABASE_INVALID", storageReplicationMessages.stateMissing, 1);
  }
  const hasMore = rows.length > ids.length;
  return {
    changesets,
    sourceBytes,
    oversized: sourceBytes > request.maxBytes,
    hasMore,
    nextSequence: hasMore ? lastSequence : 0,
    pending: count.pending,
  };
}

/**
 * Читает только исходные digest предъявленных ID одним запросом, без полного outbox.
 * Это сверка immutable metadata; проверка публикации и hash выбранных payload остаются обязательными.
 */
export function readOutboxDigests(
  connection: Database,
  ids: readonly string[],
): ReplicationSourceDigest[] {
  if (ids.length === 0) {
    return [];
  }
  return connection
    .query<ReplicationSourceDigest, [string]>(
      `SELECT id,sequence,json_extract(json,'$.replicaId') AS replicaId,
       json_extract(json,'$.digest') AS digest FROM replication_outbox
       WHERE id IN (SELECT value FROM json_each(?)) ORDER BY sequence`,
    )
    .all(JSON.stringify(ids));
}

/**
 * Читает весь граф очереди только по явному запросу диагностики blocked; prepare его не использует.
 * SQLite извлекает dependencies из всех source JSON, поэтому стоимость сканирования не ограничена окном.
 * В JS передаются лишь ID/массивы зависимостей, без effects и текстов, одним запросом.
 */
export function readOutboxDependencies(connection: Database): ReplicationDependencySource[] {
  return connection
    .query<ReplicationDependencyRow, []>(
      `SELECT id,json_extract(json,'$.dependencies') AS dependenciesJson
       FROM replication_outbox ORDER BY sequence`,
    )
    .all()
    .map((row) => {
      const dependencies: unknown = JSON.parse(row.dependenciesJson);
      if (!Array.isArray(dependencies) || !dependencies.every((id) => typeof id === "string")) {
        throw new RelayError("CORRUPT_DATA", storageReplicationMessages.corruptChangeset, 1, {
          id: row.id,
        });
      }
      return { id: row.id, dependencies };
    });
}
