import { RelayError, isEntityKind, type ProjectEntity } from "@relay/contracts";
import type { ProjectDatabase } from "@relay/storage";
import { EntityService } from "../entities/entities";
import { EntityReader } from "../projections/entity-reader";
import { queryMessages } from "./queries.messages";
import type { EntitySearchRequest } from "./queries.types";

/**
 * Проверяет внешние поля поиска и сохраняет исходный текст для точного resolver.
 * Неизвестные поля, пустой запрос и неизвестный вид отклоняются как INVALID_ARGUMENT.
 */
export function parseEntitySearch(input: Readonly<Record<string, unknown>>): EntitySearchRequest {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !["q", "kind"].includes(key))
  ) {
    throw new RelayError("INVALID_ARGUMENT", queryMessages.searchFields, 2);
  }
  if (typeof input.q !== "string" || !input.q.trim()) {
    throw new RelayError("INVALID_ARGUMENT", queryMessages.emptySearch, 2);
  }
  if (input.kind !== undefined && !isEntityKind(input.kind)) {
    throw new RelayError("INVALID_ARGUMENT", queryMessages.unknownSearchKind, 2);
  }
  return { query: input.q, kind: input.kind };
}

/**
 * Выбирает предметные тексты проверенной карточки по её виду.
 * Авторство, даты, технические ссылки и журнал комментариев не являются содержанием поиска.
 */
function entitySearchTexts(
  entity: Readonly<ProjectEntity>,
): readonly (string | null | undefined)[] {
  switch (entity.kind) {
    case "project":
      return [entity.data.name, entity.data.slug];
    case "product":
    case "feature":
    case "scenario":
      return [entity.data.name, entity.data.summary, entity.data.description];
    case "application":
      return [
        entity.data.name,
        entity.data.summary,
        entity.data.description,
        entity.data.slug,
        entity.data.prefix,
      ];
    case "board":
      return [entity.data.name, entity.data.description, entity.data.slug, entity.data.prefix];
    case "implementation":
      return [entity.data.title, entity.data.description];
    case "document":
      return [
        entity.data.name,
        entity.data.summary,
        entity.data.body,
        ...entity.data.relations.map((relation) => relation.description),
      ];
    case "task":
      return [
        entity.data.title,
        entity.data.description,
        ...entity.data.acceptanceCriteria.flatMap((criterion) => [
          criterion.title,
          criterion.summary,
          criterion.description,
        ]),
      ];
    case "work-plan":
      return [
        entity.data.title,
        entity.data.summary,
        entity.data.goal,
        entity.data.rationale,
        entity.data.boundaries,
        entity.data.expectedResult,
        entity.data.result,
        ...entity.data.stages.flatMap((stage) => [
          stage.title,
          stage.summary,
          stage.outcome,
          stage.completionConditions,
        ]),
      ];
    case "release":
      return [entity.data.title, entity.data.summary, entity.data.description, entity.data.version];
    case "work-session":
      return [
        entity.data.title,
        entity.data.description,
        entity.data.result,
        ...entity.data.runs.flatMap((run) => [run.reason, run.endReason]),
      ];
    case "work-checkpoint":
      return [
        entity.data.title,
        entity.data.summary,
        entity.data.body,
        entity.data.done,
        entity.data.remaining,
        entity.data.nextStep,
        entity.data.checks,
      ];
  }
}

/**
 * Проверяет подстроку без учёта регистра в ID, текущем ключе и предметных текстах карточки.
 */
function subjectMatches(entity: Readonly<ProjectEntity>, query: string): boolean {
  return [entity.id, entity.key, ...entitySearchTexts(entity)].some(
    (value) => typeof value === "string" && value.toLowerCase().includes(query),
  );
}

/**
 * Пробует общий resolver для точного совпадения, сохраняя приоритет ID/ключа/алиаса.
 * Произвольный поисковый текст может не быть адресом; ошибки БД и повреждения не скрываются.
 */
function resolveSearchIdentity(
  entities: EntityService,
  request: EntitySearchRequest,
): string | undefined {
  try {
    return entities.resolve(request.query, request.kind).id;
  } catch (error) {
    if (
      !(error instanceof RelayError) ||
      !["NOT_FOUND", "INVALID_ARGUMENT", "VALIDATION_ERROR"].includes(error.code)
    ) {
      throw error;
    }
    return undefined;
  }
}

/**
 * Ищет в уже открытом снимке проекта: весь выбранный вид декодируется до фильтрации.
 * Стоимость включает полные карточки; повреждение даже несовпавшей карточки не скрывается.
 * Один reader переиспользует индекс разделов для всех документов текущего поиска.
 */
export function searchProjectEntities(
  db: ProjectDatabase,
  request: EntitySearchRequest,
): ProjectEntity[] {
  const entities = new EntityService(db);
  const reader = new EntityReader(db);
  const exactId = resolveSearchIdentity(entities, request);
  const lowered = request.query.toLowerCase();
  return entities
    .list(request.kind)
    .map((item) => reader.decode(item))
    .filter((item) => item.id === exactId || subjectMatches(item, lowered));
}
