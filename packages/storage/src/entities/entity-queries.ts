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
import type { EntityCountRow, EntityRevision, EntityRow } from "./entity-queries.types";
import { entityMessages } from "./entity.messages";

// Полная карточка и журнал читаются одним запросом, без N+1 и копий комментариев в payload.
const ENTITY_COLUMNS = `e.*, CASE WHEN e.kind = 'task' THEN (
  SELECT json_group_array(json_object(
    'id', id, 'title', title, 'body', body, 'createdAt', created_at, 'createdBy', created_by
  ) ORDER BY sequence) FROM task_comments WHERE task_id = e.id
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
 * Читает карточку и комментарии одним запросом по ID, ключу или алиасу.
 * Отсутствующая ссылка и несовпадение ожидаемого вида возвращают undefined.
 */
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
  return row && (kind === undefined || row.kind === kind) ? decodeEntityRow(row) : undefined;
}

/**
 * Разрешает ID, ключ или алиас без JSON и журнала; несовпадение вида считается отсутствием.
 */
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

/**
 * Читает существование постоянного ID и ревизию без содержания, журнала и разрешения алиасов.
 * Отсутствующий ID возвращает undefined; согласованность с записью удерживает вызывающая транзакция.
 */
export function getEntityRevision(connection: Database, id: string): EntityRevision | undefined {
  return (
    connection
      .query<EntityRevision, [string]>("SELECT id, revision FROM entities WHERE id = ?")
      .get(id) ?? undefined
  );
}

/**
 * Загружает найденные карточки по постоянным ID одним SQL-запросом, включая журналы задач.
 * Порядок и повторы входа сохраняются; отсутствующие ID и другой вид пропускаются до декодирования.
 * Ключи и алиасы не разрешаются; пустой пакет не обращается к SQL.
 */
export function getEntities(
  connection: Database,
  ids: readonly string[],
  kind?: EntityKind,
): EntityRecord[] {
  if (ids.length === 0) {
    return [];
  }
  return connection
    .query<EntityRow, [string, string | null, string | null]>(
      `SELECT ${ENTITY_COLUMNS}
       FROM json_each(?) requested JOIN entities e ON e.id = requested.value
       WHERE (? IS NULL OR e.kind = ?) ORDER BY requested.key`,
    )
    .all(JSON.stringify(ids), kind ?? null, kind ?? null)
    .map(decodeEntityRow);
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
 * Загружает весь выбранный набор вместе с журналами одним SQL-запросом, по ключу и ID.
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
  return rows.map(decodeEntityRow);
}

/**
 * Загружает карточки выбранного вида с точным строковым полем верхнего уровня JSON.
 * Один SQL-запрос отбирает записи до загрузки содержания и журналов; порядок — по ключу и ID.
 * Имя поля сравнивается буквально, включая точки и кавычки, а не интерпретируется как JSON-путь.
 */
export function listEntitiesByField(
  connection: Database,
  kind: EntityKind,
  field: string,
  value: string,
): EntityRecord[] {
  return connection
    .query<EntityRow, [string, string, string]>(
      `SELECT ${ENTITY_COLUMNS} FROM entities e WHERE e.kind = ? AND EXISTS (
         SELECT 1 FROM json_each(e.data) field
         WHERE field.key = ? AND field.type = 'text' AND field.value = ?
       ) ORDER BY e.key, e.id`,
    )
    .all(kind, field, value)
    .map(decodeEntityRow);
}

/**
 * Проверяет наличие объекта с точным строковым полем в верхнеуровневом массиве сущности вида.
 * Имена полей буквальные; один SQL-запрос возвращает только признак существования без содержания.
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
  return (
    connection
      .query<unknown, [string, string, string, string]>(
        `SELECT 1 FROM entities e WHERE e.kind = ? AND EXISTS (
           SELECT 1 FROM json_each(e.data) array_field
           JOIN json_each(CASE WHEN array_field.type = 'array'
             THEN array_field.value ELSE '[]' END) item
           JOIN json_each(CASE WHEN item.type = 'object'
             THEN item.value ELSE '{}' END) item_field
           WHERE array_field.key = ? AND item_field.key = ?
             AND item_field.type = 'text' AND item_field.value = ?
         ) LIMIT 1`,
      )
      .get(kind, arrayField, itemField, value) !== null
  );
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
  return connection
    .query<EntityRow, [string, number, number]>(
      `SELECT ${ENTITY_COLUMNS} FROM entities e WHERE e.kind = ?
       ORDER BY ${order}, e.id LIMIT ? OFFSET ?`,
    )
    .all(kind, options.limit, options.offset)
    .map(decodeEntityRow);
}

/**
 * Читает обязательства всех задач без тяжёлого текста и журнала в одном SQL-снимке.
 * Неверные формы обязательств сохраняются для предметного декодера Core, а не заменяются пустыми.
 */
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
    .map(decodeEntityRow);
}
