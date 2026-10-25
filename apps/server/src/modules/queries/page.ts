import {
  isEntityKind,
  RelayError,
  validateEntityPageRequest,
  type EntityPage,
  type EntityPageRequest,
  type HttpEntityPage,
  type ProjectEntity,
} from "@relay/contracts";
import { HistoryService, KnowledgeService, PlanningService, TasksService } from "@relay/core";
import type { ProjectDatabase } from "@relay/storage";
import { filters, integerQuery, invalidInput, single } from "../../http/query";
import { httpMessages } from "../../http/http.messages";

/**
 * История не имеет SQL page: окно выделяется из полного отфильтрованного набора одного snapshot.
 */
function historyWindow(items: ProjectEntity[], page: EntityPageRequest): EntityPage<ProjectEntity> {
  items.sort((left, right) => {
    if (page.sort === "updated") {
      return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
    }
    /**
     * Исторические записи без title сортируются по собственному читаемому ключу.
     */
    const title = (item: ProjectEntity): string =>
      "title" in item.data ? item.data.title : item.key;
    const order =
      page.sort === "title"
        ? title(left).localeCompare(title(right))
        : left.key.localeCompare(right.key);
    return order || left.id.localeCompare(right.id);
  });
  return { total: items.length, items: items.slice(page.offset, page.offset + page.limit) };
}

/**
 * Проверяет поколение и читает страницу одного Core-вида в одном SQLite snapshot.
 * Offset продолжения требует исходного generation; фильтры и стоимость остаются у владельца вида.
 */
export function readPage(db: ProjectDatabase, query: URLSearchParams): HttpEntityPage {
  const kind = single(query, "kind");
  const sort = single(query, "sort") ?? "key";
  if (!isEntityKind(kind)) {
    invalidInput("kind");
  }
  if (sort !== "key" && sort !== "title" && sort !== "updated") {
    invalidInput("sort");
  }
  const page: EntityPageRequest = {
    offset: integerQuery(query, "offset") ?? 0,
    limit: integerQuery(query, "limit") ?? 40,
    sort,
  };
  validateEntityPageRequest(page);
  const expected = integerQuery(query, "generation");
  if (page.offset > 0 && expected === undefined) {
    throw new RelayError("INVALID_ARGUMENT", httpMessages.pageGeneration, 2);
  }
  const input = filters(
    query,
    ["kind", "sort", "offset", "limit", "generation"],
    kind === "task" || kind === "work-session",
  );
  return db.snapshot(() => {
    const generation = db.getGeneration();
    if (expected !== undefined && expected !== generation) {
      throw new RelayError("PAGE_CHANGED", httpMessages.pageChanged, 4, {
        expected,
        actual: generation,
      });
    }
    let result: EntityPage<ProjectEntity>;
    switch (kind) {
      case "task":
        result = new TasksService(db).listPage(input, page);
        break;
      case "work-plan":
      case "release":
        result = new PlanningService(db).listPage(kind, input, page);
        break;
      case "work-session":
        result = historyWindow(new HistoryService(db).list(input), page);
        break;
      case "work-checkpoint": {
        if (Object.keys(input).some((key) => key !== "session")) {
          invalidInput("filters");
        }
        result = historyWindow(
          new HistoryService(db).history(
            typeof input.session === "string" ? input.session : undefined,
          ),
          page,
        );
        break;
      }
      default:
        result = new KnowledgeService(db).listPage(kind, input, page);
    }
    const next = page.offset + result.items.length;
    return { ...result, generation, nextOffset: next < result.total ? next : null };
  });
}
