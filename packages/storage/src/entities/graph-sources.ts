import type { Database } from "bun:sqlite";
import { RelayError, type EntityRecord } from "@relay/contracts";
import type { EntityRow } from "./entity-queries.types";
import { graphSourceMessages } from "./graph-sources.messages";

/**
 * Выбирает только элементы массива, сохраняя неверную форму для декодера Core.
 * SQL-выражения статичны и не принимают пользовательские пути/фрагменты.
 */
function inlineArray(field: string, item: string): string {
  return `CASE WHEN json_type(e.data,'$.${field}')='array' THEN json((SELECT json_group_array(json(CASE WHEN v.type='object' THEN ${item} ELSE json_quote(v.value) END) ORDER BY v.key) FROM json_each(e.data,'$.${field}') v)) ELSE json_extract(e.data,'$.${field}') END`;
}

/**
 * Собирает узкую коллекцию primary parts; inline+normalized конфликт не маскируется.
 */
function collection(
  field: string,
  kind: string,
  value: string,
  fallback = `json_extract(e.data,'$.${field}')`,
): string {
  return `CASE WHEN EXISTS(SELECT 1 FROM entity_components m WHERE m.owner_id=e.id AND m.kind='collection' AND m.id='${field}' AND m.deleted=0)
    THEN CASE WHEN json_type(e.data,'$.${field}') IS NOT NULL THEN NULL ELSE json((SELECT json_group_array(${value} ORDER BY c.position,c.id) FROM entity_components c WHERE c.owner_id=e.id AND c.kind='${kind}' AND c.deleted=0)) END
    ELSE ${fallback} END`;
}

const stripped = `json_remove(e.data,'$.description','$.body','$.done','$.remaining','$.nextStep','$.checks','$.result','$.rationale','$.goal','$.boundaries','$.expectedResult','$.completionConditions','$.outcome','$.comments','$.acceptanceCriteria','$.participants','$.documentSections','$.retiredDocumentSectionIds')`;
const runValue = `json(json_remove(c.value,'$.reason','$.endReason'))`;
const runs = collection(
  "runs",
  "session-run",
  runValue,
  inlineArray("runs", `json_remove(v.value,'$.reason','$.endReason')`),
);
const stageValue = `json_object('id',json(c.value->'$.id'),'title',json(c.value->'$.title'),'taskIds',json((SELECT json_group_array(json(t.value->'$.taskId') ORDER BY t.position,t.id) FROM entity_components t WHERE t.owner_id=e.id AND t.kind='plan-task' AND t.deleted=0 AND t.group_id=c.id)))`;
const stages = collection(
  "stages",
  "plan-stage",
  stageValue,
  inlineArray(
    "stages",
    `json_object('id',json(v.value->'$.id'),'title',json(v.value->'$.title'),'taskIds',json(v.value->'$.taskIds'))`,
  ),
);
const relationsData = `CASE e.kind
  WHEN 'task' THEN json_set(${stripped},'$.dependencies',${collection("dependencies", "task-dependency", `json(c.value->'$.taskId')`)},'$.related',${collection("related", "task-related", `json(c.value->'$.taskId')`)},'$.targets',${collection("targets", "task-target", `json(c.value->'$.targetId')`)})
  WHEN 'document' THEN json_set(${stripped},'$.relations',${collection("relations", "document-relation", "json(c.value)")})
  WHEN 'application' THEN json_set(${stripped},'$.implementationIds',${collection("implementationIds", "application-participation", `json(c.value->'$.implementationId')`)})
  WHEN 'work-plan' THEN json_set(${stripped},'$.scope',${collection("scope", "plan-scope", "json(c.value)")},'$.stages',${stages})
  WHEN 'release' THEN json_set(${stripped},'$.planIds',${collection("planIds", "release-plan", `json(c.value->'$.planId')`)})
  WHEN 'work-session' THEN json_remove(${stripped},'$.runs')
  WHEN 'work-checkpoint' THEN json_set(${stripped},'$.references',${inlineArray("references", `json_object('id',json(v.value->'$.id'),'kind',json(v.value->'$.kind'))`)})
  ELSE ${stripped} END`;

/**
 * Читает узкие источники истории либо структурированных связей одним SQL-запросом.
 * Не возвращает Markdown-тела, журнал задач, критерии, причины участия и итоги сессий.
 * Для сортировки timeline/входящих связей пока сканирует все соответствующие metadata:
 * Объём raw-результата O(N + E + R), без кеша и ограничения числа сущностей проекта.
 * JSON в SQLite всё ещё разбирается; это не обещание индексного seek для каждого ребра.
 * Форму выбранных data и ссылок проверяет Core; полная карточка здесь не декодируется.
 */
export function graphSourceRecords(
  connection: Database,
  view: "history" | "relations",
): EntityRecord[] {
  const data =
    view === "history"
      ? `CASE e.kind WHEN 'work-session' THEN json_set(${stripped},'$.runs',${runs}) ELSE json_remove(${stripped},'$.references','$.acceptedSessionIds') END`
      : `json_remove(${relationsData},'$.summary')`;
  const where = view === "history" ? "WHERE e.kind IN ('work-session','work-checkpoint')" : "";
  const rows = connection
    .query<EntityRow, []>(
      `SELECT e.id,e.kind,e.key,e.revision,e.created_at,e.updated_at,e.created_by,e.updated_by,${data} AS data,NULL AS comments FROM entities e ${where} ORDER BY e.id`,
    )
    .all();
  return rows.map((row) => {
    const value: unknown = JSON.parse(row.data);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new RelayError("CORRUPT_DATA", graphSourceMessages.corrupt, 1, { id: row.id });
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
      data: value as Record<string, unknown>,
    };
  });
}
