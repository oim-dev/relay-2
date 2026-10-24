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

// Полная карточка и журнал читаются одним запросом, без N+1 и копий комментариев в payload.
const ENTITY_COLUMNS = `e.*, CASE WHEN e.kind = 'task' THEN (
  SELECT json_group_array(${TASK_COMMENT_JSON} ORDER BY c.sequence) FROM ${TASK_COMMENT_SOURCE} WHERE c.task_id = e.id
) ELSE NULL END AS comments`;

// Имя поля сравнивается буквально, а значение — только как строка верхнего уровня JSON.
const ENTITY_STRING_FIELD_MATCH = `e.kind = ? AND EXISTS (
  SELECT 1 FROM json_each(e.data) field
  WHERE field.key = json_extract(?, '$') AND field.type = 'text' AND field.value = json_extract(?, '$')
)`;

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
      `SELECT e.id, e.kind, e.key FROM entity_refs r JOIN entities e ON e.id = r.entity_id
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
       JOIN entity_refs r ON r.ref = requested.value JOIN entities e ON e.id = r.entity_id`,
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
      `SELECT e.id, e.kind, e.key, e.revision,
         CASE WHEN e.kind IN ('project', 'product', 'feature', 'scenario', 'application', 'board', 'document')
           THEN e.data -> '$.name' ELSE e.data -> '$.title' END AS title,
         CASE e.kind WHEN 'task' THEN e.data -> '$.column'
           WHEN 'document' THEN e.data -> '$.documentStatus'
           WHEN 'implementation' THEN e.data -> '$.status'
           WHEN 'work-plan' THEN e.data -> '$.status'
           WHEN 'release' THEN e.data -> '$.status'
           WHEN 'work-session' THEN e.data -> '$.status' END AS state,
         CASE WHEN e.kind = 'implementation' THEN e.data -> '$.active' END AS active
       FROM json_each(?) requested JOIN entities e ON e.id = requested.value`,
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
      .query<EntityRevision, [string]>("SELECT id, revision FROM entities WHERE id = ?")
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
       FROM json_each(?) requested JOIN entities e ON e.id = requested.value
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
    .query<EntityIdentity, [string, string, string]>(
      `SELECT id, kind, key FROM entities WHERE kind = ? AND (
         (json_type(data, '$.slug') = 'text' AND json_extract(data, '$.slug') = ?) OR
         (json_type(data, '$.prefix') = 'text' AND json_extract(data, '$.prefix') = ?)
       ) ORDER BY id`,
    )
    .all(kind, ref, ref);
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
 * Загружает карточки выбранного вида с точным строковым полем верхнего уровня JSON.
 * SQL отбирает owners до загрузки содержания; один пакет parts ограничен выбранными ID.
 * Имя поля сравнивается буквально, включая точки и кавычки, а не интерпретируется как JSON-путь.
 */
export function listEntitiesByField(
  connection: Database,
  kind: EntityKind,
  field: string,
  value: string,
): EntityRecord[] {
  const rows = connection
    .query<EntityRow, [string, string, string]>(
      `SELECT ${ENTITY_COLUMNS} FROM entities e WHERE ${ENTITY_STRING_FIELD_MATCH}
       ORDER BY e.key, e.id`,
    )
    .all(kind, JSON.stringify(field), JSON.stringify(value))
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
    .query<EntityIdentityWithRevision, [string, string, string]>(
      `SELECT e.id, e.kind, e.key, e.revision FROM entities e WHERE ${ENTITY_STRING_FIELD_MATCH}
       ORDER BY e.key, e.id`,
    )
    .all(kind, JSON.stringify(field), JSON.stringify(value));
}

/**
 * Проверяет наличие объекта с точным строковым полем в верхнеуровневом массиве сущности вида.
 * Имена полей буквальные; один SQL объединяет normalized parts и raw fallback в одном снимке.
 * Возвращается лишь признак существования, без передачи содержания и JSON-декодирования в JS.
 * Неподходящие формы массива, элемента и поля не совпадают; скалярный текст не разбирается как JSON.
 * Снимок нескольких обращений удерживает вызывающий.
 */
export function hasEntityArrayItemByField(
  connection: Database,
  kind: EntityKind,
  arrayField: string,
  itemField: string,
  value: string,
): boolean {
  const normalizedKinds: Readonly<Record<string, string>> = {
    acceptanceCriteria: "task-criterion",
    stages: "plan-stage",
    scope: "plan-scope",
    relations: "document-relation",
    runs: "session-run",
    documentSections: "document-section",
  };
  const componentKind = Object.hasOwn(normalizedKinds, arrayField)
    ? normalizedKinds[arrayField]
    : undefined;
  return (
    connection
      .query<unknown, [string, string | null, string, string, string, string, string, string]>(
        `SELECT 1 FROM entities e WHERE e.kind = ? AND (
          EXISTS (
            SELECT 1 FROM entity_components c JOIN json_each(c.value) field
            WHERE c.owner_id=e.id AND c.kind=? AND c.deleted=0
              AND EXISTS (SELECT 1 FROM entity_components declaration
                WHERE declaration.owner_id=e.id AND declaration.kind='collection'
                  AND declaration.id=json_extract(?, '$') AND declaration.deleted=0)
              AND field.key=json_extract(?, '$') AND field.type='text'
              AND field.value=json_extract(?, '$')
          ) OR EXISTS (
            SELECT 1 FROM json_each(e.data) array_field
            JOIN json_each(CASE WHEN array_field.type = 'array'
              THEN array_field.value ELSE '[]' END) item
           JOIN json_each(CASE WHEN item.type = 'object'
             THEN item.value ELSE '{}' END) item_field
            WHERE array_field.key = json_extract(?, '$') AND item_field.key = json_extract(?, '$')
              AND item_field.type = 'text' AND item_field.value = json_extract(?, '$')
          )
        ) LIMIT 1`,
      )
      .get(
        kind,
        componentKind ?? null,
        JSON.stringify(arrayField),
        JSON.stringify(itemField),
        JSON.stringify(value),
        JSON.stringify(arrayField),
        JSON.stringify(itemField),
        JSON.stringify(value),
      ) !== null
  );
}

/**
 * Читает планы, содержащие taskId, по индексу первичных membership, затем гидратирует одним пакетом.
 * Незавершённые и исторические включения возвращаются вместе; правила открытого состава принадлежат Core.
 * Нераспознаваемый inline stages не считается отсутствием включений: такой owner возвращается для диагностики.
 */
export function listTaskMembershipOwners(connection: Database, taskId: string): EntityRecord[] {
  assertSqlText(taskId, "taskId");
  const rows = connection
    .query<EntityRow, [string]>(
      `SELECT ${ENTITY_COLUMNS} FROM entities e WHERE e.kind='work-plan' AND (
    e.id IN (SELECT owner_id FROM entity_components WHERE kind='plan-task' AND deleted=0 AND target_id=?)
    OR json_type(e.data,'$.stages') IS NOT NULL) ORDER BY e.key,e.id`,
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
      ? connection.query<EntityCountRow, []>("SELECT count(*) AS count FROM entities").get()
      : connection
          .query<EntityCountRow, [string]>("SELECT count(*) AS count FROM entities WHERE kind = ?")
          .get(kind);
  if (!row) {
    throw new RelayError("STORAGE_ERROR", entityMessages.countMissing);
  }
  return row.count;
}

/**
 * Загружает только окно, ограниченное SQL LIMIT/OFFSET, вместе с содержанием и комментариями.
 * Параметры страницы предварительно проверяет ProjectDatabase; ID стабилизирует равные ключи сортировки.
 */
export function entityWindow(
  connection: Database,
  kind: EntityKind,
  options: EntityPageRequest,
): EntityRecord[] {
  let order = "e.key";
  if (options.sort === "updated") {
    order = "e.updated_at DESC";
  } else if (options.sort === "title") {
    order = "coalesce(json_extract(e.data, '$.title'), json_extract(e.data, '$.name'), '')";
  }
  const rows = connection
    .query<EntityRow, [string, number, number]>(
      `SELECT ${ENTITY_COLUMNS} FROM entities e WHERE e.kind = ?
       ORDER BY ${order}, e.id LIMIT ? OFFSET ?`,
    )
    .all(kind, options.limit, options.offset)
    .map(decodeEntityRow);
  return hydrateComponentRecords(connection, rows);
}

/**
 * Читает обязательства всех задач без тяжёлого текста и журнала в одном SQL-снимке.
 * Неверные формы обязательств сохраняются для предметного декодера Core, а не заменяются пустыми.
 * INDEXED BY удерживает metadata-only путь: SQLite иначе предпочитает более узкий непокрывающий индекс.
 */
export function taskGraphRecords(connection: Database): EntityRecord[] {
  return connection
    .query<EntityRow, []>(
      `SELECT e.id, e.kind, e.key, e.revision, e.created_at, e.updated_at,
              e.created_by, e.updated_by,
              json_set(
                json_remove(e.data, '$.title', '$.description', '$.boardId', '$.related', '$.targets'),
                 '$.dependencies', CASE
                   WHEN EXISTS(SELECT 1 FROM entity_components mark INDEXED BY components_owner_version WHERE mark.owner_id=e.id AND mark.kind='collection' AND mark.id='dependencies' AND mark.deleted=0) THEN
                     CASE WHEN json_type(e.data,'$.dependencies') IS NOT NULL THEN NULL ELSE json((SELECT json_group_array(target_id ORDER BY position,id) FROM entity_components INDEXED BY components_task_graph WHERE owner_id=e.id AND kind='task-dependency' AND deleted=0)) END
                   ELSE json_extract(e.data,'$.dependencies') END,
                 '$.acceptanceCriteria', CASE
                   WHEN EXISTS(SELECT 1 FROM entity_components mark INDEXED BY components_owner_version WHERE mark.owner_id=e.id AND mark.kind='collection' AND mark.id='acceptanceCriteria' AND mark.deleted=0) THEN
                     CASE WHEN json_type(e.data,'$.acceptanceCriteria') IS NOT NULL THEN NULL ELSE json((SELECT json_group_array(json_object('completed',json(completed_json)) ORDER BY position,id) FROM entity_components INDEXED BY components_task_graph WHERE owner_id=e.id AND kind='task-criterion' AND deleted=0)) END
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
    .map(decodeEntityRow);
}
