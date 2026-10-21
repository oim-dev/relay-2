/** SQL-проекции сущностей; соединением, снимками и преобразованием ошибок владеет ProjectDatabase. */
import type { Database } from "bun:sqlite";
import type { EntityIdentity, EntityKind, EntityRecord, EntityPageRequest } from "@relay/contracts";

interface EntityRow {
  id: string;
  kind: EntityKind;
  key: string;
  revision: number;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
  data: string;
  comments: string | null;
}

// Полная карточка и журнал читаются одним запросом, без N+1 и копий комментариев в payload.
const ENTITY_COLUMNS = `e.*, CASE WHEN e.kind = 'task' THEN (
  SELECT json_group_array(json_object(
    'id', id, 'title', title, 'body', body, 'createdAt', created_at, 'createdBy', created_by
  ) ORDER BY sequence) FROM task_comments WHERE task_id = e.id
) ELSE NULL END AS comments`;

function record(row: EntityRow): EntityRecord {
  const data = JSON.parse(row.data) as Record<string, unknown>;
  if (row.kind === "task" && row.comments !== null) data.comments = JSON.parse(row.comments);
  return {
    id: row.id,
    kind: row.kind,
    key: row.key,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    data,
  };
}

export function getEntity(
  connection: Database,
  ref: string,
  kind?: EntityKind,
): EntityRecord | undefined {
  const row = connection
    .query<EntityRow, [string]>(
      `SELECT ${ENTITY_COLUMNS} FROM entity_refs r JOIN entities e ON e.id = r.entity_id
       WHERE r.ref = ?`,
    )
    .get(ref);
  return row && (kind === undefined || row.kind === kind) ? record(row) : undefined;
}

export function getEntityIdentity(
  connection: Database,
  ref: string,
  kind?: EntityKind,
): EntityIdentity | undefined {
  const identity = connection
    .query<EntityIdentity, [string]>(
      `SELECT e.id, e.kind, e.key FROM entity_refs r JOIN entities e ON e.id = r.entity_id
       WHERE r.ref = ?`,
    )
    .get(ref);
  return identity && (kind === undefined || identity.kind === kind) ? identity : undefined;
}

export function findAddressIdentities(
  connection: Database,
  ref: string,
  kind: EntityKind,
): EntityIdentity[] {
  return connection
    .query<EntityIdentity, [string, string, string]>(
      `SELECT id, kind, key FROM entities WHERE kind = ? AND (
         (json_type(data, '$.slug') = 'text' AND json_extract(data, '$.slug') = ?) OR
         (json_type(data, '$.prefix') = 'text' AND json_extract(data, '$.prefix') = ?)
       ) ORDER BY id`,
    )
    .all(kind, ref, ref);
}

export function listEntities(connection: Database, kind?: EntityKind): EntityRecord[] {
  const rows =
    kind === undefined
      ? connection
          .query<EntityRow, []>(`SELECT ${ENTITY_COLUMNS} FROM entities e ORDER BY e.key, e.id`)
          .all()
      : connection
          .query<EntityRow, [string]>(
            `SELECT ${ENTITY_COLUMNS} FROM entities e WHERE e.kind = ? ORDER BY e.key, e.id`,
          )
          .all(kind);
  return rows.map(record);
}

export function countEntities(connection: Database, kind?: EntityKind): number {
  return kind === undefined
    ? connection.query<{ count: number }, []>("SELECT count(*) AS count FROM entities").get()!.count
    : connection
        .query<{ count: number }, [string]>("SELECT count(*) AS count FROM entities WHERE kind = ?")
        .get(kind)!.count;
}

export function entityWindow(
  connection: Database,
  kind: EntityKind,
  options: EntityPageRequest,
): EntityRecord[] {
  const order =
    options.sort === "updated"
      ? "e.updated_at DESC"
      : options.sort === "title"
        ? "coalesce(json_extract(e.data, '$.title'), json_extract(e.data, '$.name'), '')"
        : "e.key";
  return connection
    .query<EntityRow, [string, number, number]>(
      `SELECT ${ENTITY_COLUMNS} FROM entities e WHERE e.kind = ?
       ORDER BY ${order}, e.id LIMIT ? OFFSET ?`,
    )
    .all(kind, options.limit, options.offset)
    .map(record);
}

export function taskGraphRecords(connection: Database): EntityRecord[] {
  return connection
    .query<EntityRow, []>(
      `SELECT e.id, e.kind, e.key, e.revision, e.created_at, e.updated_at,
              e.created_by, e.updated_by,
              json_set(
                json_remove(e.data, '$.title', '$.description', '$.boardId', '$.related', '$.targets'),
                '$.acceptanceCriteria', CASE
                  WHEN json_type(e.data, '$.acceptanceCriteria') = 'array' THEN json((
                    SELECT json_group_array(json(CASE
                      WHEN criterion.type = 'object'
                        THEN json_object('completed', json(criterion.value -> '$.completed'))
                      ELSE json_quote(criterion.value)
                    END))
                    FROM json_each(e.data, '$.acceptanceCriteria') criterion
                  ))
                  ELSE json_extract(e.data, '$.acceptanceCriteria')
                END
              ) AS data, NULL AS comments
       FROM entities e WHERE e.kind = 'task' ORDER BY e.key, e.id`,
    )
    .all()
    .map(record);
}
