/**
 * SQL-проекции сущностей; соединением, снимками и преобразованием ошибок владеет ProjectDatabase.
 */
import type { Database } from "bun:sqlite";
import {
  RelayError,
  type EntityIdentity,
  type EntityKind,
  type EntityRecord,
  type EntityPageRequest,
} from "@relay/contracts";
import type {
  EntityCountRow,
  EntityIdentityWithRevision,
  EntityReferenceIdentity,
  EntityRevision,
  EntityRow,
  EntitySummaryProjection,
  EntitySummaryRow,
} from "./entity-queries.types";
import { entityMessages } from "./entity.messages";
import { hydrateComponentRecords } from "../components/component-hydration";
import { assertSqlReferences, assertSqlText } from "./entity-sql-text";
import { TASK_COMMENT_JSON, TASK_COMMENT_SOURCE } from "./comment-text";
import { entityArrayItemFilter, entityFieldFilter } from "./relational-selections";

// Полная карточка и журнал читаются одним запросом, без N+1 и копий комментариев в payload.
const ENTITY_COLUMNS = `e.*, CASE WHEN e.kind = 'task' THEN (
  SELECT json_group_array(${TASK_COMMENT_JSON} ORDER BY c.sequence) FROM ${TASK_COMMENT_SOURCE} WHERE c.task_id = e.id
) ELSE NULL END AS comments`;

/**
 * Проверяет корневой JSON-объект, оставляя вложенные значения предметному декодеру Core.
 */
function isEntityPayload(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Декодирует объект содержания и добавляет запрошенную SQL-проекцию журнала задачи.
 * Форму вложенных предметных данных сохраняет для Core; повреждённый корневой JSON не маскируется.
 */
function decodeEntityRow(row: EntityRow): EntityRecord {
  const data: unknown = JSON.parse(row.data);
  if (!isEntityPayload(data)) {
    throw new RelayError("STORAGE_ERROR", entityMessages.invalidPayload, 1, { id: row.id });
  }
  if (row.kind === "task" && row.comments !== null) {
    data.comments = JSON.parse(row.comments);
  }
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

/**
 * Читает raw-проекцию владельца по постоянному ID без гидратации частей и журнала.
 * Используется для точного before/after репликации в транзакции записи; отсутствие даёт undefined.
 */
export function getRawEntity(connection: Database, id: string): EntityRecord | undefined {
  assertSqlText(id, "id");
  const row = connection
    .query<EntityRow, [string]>("SELECT e.*,NULL AS comments FROM entities e WHERE e.id=?")
    .get(id);
  return row === null ? undefined : decodeEntityRow(row);
}

/**
 * Читает owner/комментарии и его primary parts двумя запросами по ID, ключу или алиасу.
 * Вызывающий удерживает согласованный snapshot на оба чтения.
 * Отсутствующая ссылка и несовпадение ожидаемого вида возвращают undefined.
 */
export function getEntity(
  connection: Database,
  ref: string,
  kind?: EntityKind,
): EntityRecord | undefined {
  assertSqlText(ref, "ref");
  const row = connection
    .query<EntityRow, [string]>(
      `SELECT ${ENTITY_COLUMNS} FROM entity_refs r JOIN entities e ON e.id = r.entity_id
       WHERE r.ref = ?`,
    )
    .get(ref);
  return row && (kind === undefined || row.kind === kind)
    ? hydrateComponentRecords(connection, [decodeEntityRow(row)])[0]
    : undefined;
}

/**
 * Разрешает ID, ключ или алиас без JSON и журнала; несовпадение вида считается отсутствием.
 */
export function getEntityIdentity(
  connection: Database,
  ref: string,
  kind?: EntityKind,
): EntityIdentity | undefined {
  assertSqlText(ref, "ref");
  const identity = connection
    .query<EntityIdentity, [string]>(
      `SELECT e.id, e.kind, e.key FROM entity_refs r JOIN entity_identities e ON e.id = r.entity_id
       WHERE r.ref = ?`,
    )
    .get(ref);
  return identity && (kind === undefined || identity.kind === kind) ? identity : undefined;
}

/**
 * Разрешает пакет обычных ID, ключей и алиасов через entity_refs одним SQL-запросом.
 * Каждый вход получает идентичность либо явный null; порядок и повторы сохраняются.
 * Типизированный и виртуальный синтаксис принадлежит Core; пустой пакет не обращается к SQL.
 */
export function resolveEntityReferences(
  connection: Database,
  refs: readonly string[],
): (EntityIdentity | null)[] {
  assertSqlReferences(refs);
  if (refs.length === 0) {
    return [];
  }
  const rows = connection
    .query<EntityReferenceIdentity, [string]>(
      `SELECT r.ref, e.id, e.kind, e.key
       FROM json_each(?) requested
       JOIN entity_refs r ON r.ref = requested.value JOIN entity_identities e ON e.id = r.entity_id`,
    )
    .all(JSON.stringify([...new Set(refs)]));
  const identities = new Map(rows.map(({ ref, id, kind, key }) => [ref, { id, kind, key }]));
  return refs.map((ref) => identities.get(ref) ?? null);
}

/**
 * Читает только идентичность, ревизию, название и состояние выбранных постоянных ID.
 * SQL не возвращает тела, вложенные составы и журналы. Типы JSON-полей сохраняются для Core.
 * Пропуски явно возвращаются как null; порядок и повторы входа сохраняются без повторной загрузки.
 */
export function getEntitySummaries(
  connection: Database,
  ids: readonly string[],
): (EntitySummaryProjection | null)[] {
  assertSqlReferences(ids);
  if (ids.length === 0) {
    return [];
  }
  const rows = connection
    .query<EntitySummaryRow, [string]>(
      `SELECT id,kind,key,revision,title,state,active FROM entity_summaries
       WHERE id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify([...new Set(ids)]));
  const summaries = new Map(
    rows.map((row) => [
      row.id,
      {
        ...row,
        title: row.title === null ? undefined : JSON.parse(row.title),
        state: row.state === null ? undefined : JSON.parse(row.state),
        active: row.active === null ? undefined : JSON.parse(row.active),
      },
    ]),
  );
  return ids.map((id) => summaries.get(id) ?? null);
}

/**
 * Читает существование постоянного ID и ревизию без содержания, журнала и разрешения алиасов.
 * Отсутствующий ID возвращает undefined; согласованность с записью удерживает вызывающая транзакция.
 */
export function getEntityRevision(connection: Database, id: string): EntityRevision | undefined {
  assertSqlText(id, "id");
  return (
    connection
      .query<EntityRevision, [string]>(
        "SELECT entity_id AS id,revision FROM local_entity_revisions WHERE entity_id=?",
      )
      .get(id) ?? undefined
  );
}

/**
 * Загружает карточки по постоянным ID: один SQL owners/journals и один пакет выбранных parts.
 * Порядок и повторы входа сохраняются; отсутствующие ID и другой вид пропускаются до декодирования.
 * Ключи и алиасы не разрешаются; пустой пакет не обращается к SQL.
 */
export function getEntities(
  connection: Database,
  ids: readonly string[],
  kind?: EntityKind,
): EntityRecord[] {
  assertSqlReferences(ids);
  if (ids.length === 0) {
    return [];
  }
  const rows = connection
    .query<EntityRow, [string, string | null, string | null]>(
      `SELECT ${ENTITY_COLUMNS}
       FROM json_each(?) requested JOIN entities e ON e.id = requested.value
       WHERE (? IS NULL OR e.kind = ?) ORDER BY requested.key`,
    )
    .all(JSON.stringify(ids), kind ?? null, kind ?? null)
    .map(decodeEntityRow);
  return hydrateComponentRecords(connection, rows);
}

/**
 * Читает идентичности по постоянным ID одним SQL-запросом без содержания и журналов.
 * Сохраняет порядок и повторы входа, пропуская отсутствующие ID и несовпадающий вид.
 * Ключи и алиасы не разрешаются; пустой пакет не обращается к SQL.
 */
export function getEntityIdentities(
  connection: Database,
  ids: readonly string[],
  kind?: EntityKind,
): EntityIdentity[] {
  assertSqlReferences(ids);
  if (ids.length === 0) {
    return [];
  }
  return connection
    .query<EntityIdentity, [string, string | null, string | null]>(
      `SELECT e.id, e.kind, e.key
       FROM json_each(?) requested JOIN entity_identities e ON e.id = requested.value
       WHERE (? IS NULL OR e.kind = ?) ORDER BY requested.key`,
    )
    .all(JSON.stringify(ids), kind ?? null, kind ?? null);
}

/**
 * Находит все точные строковые slug/prefix внутри вида в порядке постоянного ID.
 * Неоднозначность и допустимость такого адреса разрешает Core.
 */
export function findAddressIdentities(
  connection: Database,
  ref: string,
  kind: EntityKind,
): EntityIdentity[] {
  assertSqlText(ref, "ref");
  return connection
    .query<EntityIdentity, [string, string]>(
      `SELECT e.id,e.kind,e.key FROM entity_identities e
       WHERE ${entityFieldFilter(kind, "slug")} OR ${entityFieldFilter(kind, "prefix")}
       ORDER BY e.id`,
    )
    .all(JSON.stringify([JSON.stringify(ref)]), JSON.stringify([JSON.stringify(ref)]));
}

/**
 * Загружает выбранных owners/journals по ключу/ID и гидратирует части одним дополнительным SQL.
 * Для ограниченной выдачи вызывающий должен использовать entityWindow.
 */
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
  return hydrateComponentRecords(connection, rows.map(decodeEntityRow));
}

/**
 * Загружает карточки выбранного вида с точным строковым полем из закрытой карты колонок.
 * SQL отбирает owners до загрузки содержания; один пакет parts ограничен выбранными ID.
 * Имя поля буквальное; неизвестное поле не интерпретируется как SQL или вложенный путь.
 */
export function listEntitiesByField(
  connection: Database,
  kind: EntityKind,
  field: string,
  value: string,
): EntityRecord[] {
  const rows = connection
    .query<EntityRow, [string]>(
      `SELECT ${ENTITY_COLUMNS} FROM entities e WHERE ${entityFieldFilter(kind, field)}
       ORDER BY e.key, e.id`,
    )
    .all(JSON.stringify([JSON.stringify(value)]))
    .map(decodeEntityRow);
  return hydrateComponentRecords(connection, rows);
}

/**
 * Читает ID, вид, ключ и ревизию совпавших записей одним SQL-запросом без содержания и журналов.
 * Строковый фильтр и порядок по ключу/ID совпадают с listEntitiesByField; поле не является JSON-путём.
 * Согласованность нескольких выборок удерживает вызывающий snapshot либо транзакция.
 */
export function listEntityIdentitiesByField(
  connection: Database,
  kind: EntityKind,
  field: string,
  value: string,
): EntityIdentityWithRevision[] {
  return connection
    .query<EntityIdentityWithRevision, [string]>(
      `SELECT e.id, e.kind, e.key, e.revision FROM entity_identities e WHERE ${entityFieldFilter(kind, field)}
       ORDER BY e.key, e.id`,
    )
    .all(JSON.stringify([JSON.stringify(value)]));
}

/**
 * Проверяет наличие объекта с точным строковым полем в верхнеуровневом массиве сущности вида.
 * Имена полей буквальные; один SQL выбирает только известные предметные колонки.
 * Возвращается лишь признак существования, без построения полного data/value и JSON-декодирования в JS.
 * Неизвестные поля и нестроковые значения не совпадают.
 * Снимок нескольких обращений удерживает вызывающий.
 */
export function hasEntityArrayItemByField(
  connection: Database,
  kind: EntityKind,
  arrayField: string,
  itemField: string,
  value: string,
): boolean {
  return (
    connection
      .query<unknown, [string]>(
        `SELECT 1 FROM entity_identities e
         WHERE ${entityArrayItemFilter(kind, arrayField, itemField)} LIMIT 1`,
      )
      .get(JSON.stringify(value)) !== null
  );
}

/**
 * Читает планы, содержащие taskId, по индексу первичных membership, затем гидратирует одним пакетом.
 * Незавершённые и исторические включения возвращаются вместе; правила открытого состава принадлежат Core.
 * Состав выбирается по первичным plan_tasks, без построения JSON всего плана для фильтрации.
 */
export function listTaskMembershipOwners(connection: Database, taskId: string): EntityRecord[] {
  assertSqlText(taskId, "taskId");
  const rows = connection
    .query<EntityRow, [string]>(
      `SELECT ${ENTITY_COLUMNS} FROM entities e
       WHERE e.id IN (SELECT owner_id FROM plan_tasks WHERE deleted=0 AND task_id=?)
       ORDER BY e.key,e.id`,
    )
    .all(taskId);
  return hydrateComponentRecords(connection, rows.map(decodeEntityRow));
}

/**
 * Считает сущности в текущем снимке без чтения JSON и комментариев.
 */
export function countEntities(connection: Database, kind?: EntityKind): number {
  const row =
    kind === undefined
      ? connection
          .query<EntityCountRow, []>("SELECT count(*) AS count FROM entity_identities")
          .get()
      : connection
          .query<EntityCountRow, [string]>(
            "SELECT count(*) AS count FROM entity_identities WHERE kind = ?",
          )
          .get(kind);
  if (!row) {
    throw new RelayError("STORAGE_ERROR", entityMessages.countMissing);
  }
  return row.count;
}

/**
 * Сначала материализует SQL-окно ID по узким metadata, затем читает только его содержание и комментарии.
 * Параметры страницы предварительно проверяет ProjectDatabase; ID стабилизирует равные ключи сортировки.
 */
export function entityWindow(
  connection: Database,
  kind: EntityKind,
  options: EntityPageRequest,
): EntityRecord[] {
  let order = "key";
  let source = "entity_headers";
  let direction = "ASC";
  if (options.sort === "updated") {
    order = "updated_at";
    direction = "DESC";
  } else if (options.sort === "title") {
    source = "entity_summaries";
    order = "coalesce(json_extract(title,'$'),'')";
  }
  const rows = connection
    .query<EntityRow, [string, number, number]>(
      `WITH selected AS MATERIALIZED (
         SELECT id,${order} AS sort_value FROM ${source} WHERE kind=?
         ORDER BY sort_value ${direction},id LIMIT ? OFFSET ?
       )
       SELECT ${ENTITY_COLUMNS} FROM selected JOIN entities e ON e.id=selected.id
       ORDER BY selected.sort_value ${direction},e.id`,
    )
    .all(kind, options.limit, options.offset)
    .map(decodeEntityRow);
  return hydrateComponentRecords(connection, rows);
}

/**
 * Читает обязательства всех задач непосредственно из узких предметных колонок одним SQL.
 * Не читает title/description критериев и задач или журнал; отсутствие декларации не маскируется [].
 */
export function taskGraphRecords(connection: Database): EntityRecord[] {
  return connection
    .query<EntityRow, []>("SELECT * FROM task_graph_sources ORDER BY key,id")
    .all()
    .map(decodeEntityRow);
}
