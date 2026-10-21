import type {
  HistoryCheckpoint,
  HistoryContext,
  HistoryOperator,
  HistoryReference,
  HistorySession,
  ProjectEntity,
} from "@relay/contracts";
import type { ProjectDatabase } from "@relay/storage";
import { EntityService } from "../entities/entities";
import { EntityReader } from "../projections/entity-reader";
import { decodeHistoryCheckpoint, decodeHistorySession } from "./history-data";
import { historyFilters, invalidHistoryInput } from "./history-input";
import type { HistoryFilters, HistoryIntentsOptions } from "./history-input.types";
import { historyInputMessages, historyStateMessages } from "./history-messages";
import {
  historyConflict,
  historySubtree,
  openHistoryIntents,
  unfinishedSession,
} from "./history-rules";

/**
 * Проверяет фильтры сессии после разрешения ссылки родителя в текущем снимке.
 */
function matchesHistorySession(
  session: Readonly<HistorySession>,
  input: HistoryFilters,
  parentId: string | null | undefined,
): boolean {
  return (
    (input.status === undefined || session.data.status === input.status) &&
    (input.unfinished === undefined || unfinishedSession(session) === input.unfinished) &&
    (parentId === undefined || session.data.parentSessionId === parentId) &&
    (input.actor === null || session.data.runs.some((run) => run.actor === input.actor)) &&
    (input.query === null ||
      [session.key, session.data.title, session.data.description ?? ""]
        .join("\n")
        .toLocaleLowerCase()
        .includes(input.query))
  );
}

/**
 * Сортирует переданный отдельный массив материалов по времени, порядку внутри сессии и ID.
 */
function sortHistoryCheckpoints(checkpoints: HistoryCheckpoint[]): HistoryCheckpoint[] {
  return checkpoints.sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) ||
      a.data.sequence - b.data.sequence ||
      a.id.localeCompare(b.id),
  );
}

/**
 * Выбирает предметное название проверенной цели; отсутствующее имя продукта заменяется ключом.
 */
function historyReferenceTitle(target: Readonly<ProjectEntity>): string {
  switch (target.kind) {
    case "product":
      return target.data.name ?? target.key;
    case "project":
    case "feature":
    case "scenario":
    case "application":
    case "board":
    case "document":
      return target.data.name;
    default:
      return target.data.title;
  }
}

/**
 * Декодированные запросы истории и разрешение ссылок без записи в БД.
 * Составные пользовательские чтения удерживают snapshot; низкоуровневые выборки для записи
 * вызываются внутри транзакции HistoryService. Между операциями данные не кешируются.
 */
export class HistoryReader {
  /* БД проекта; временем жизни соединения управляет вызывающая сторона. */
  private readonly db: ProjectDatabase;
  /* Общий resolver адресов сессий и материалов. */
  private readonly entities: EntityService;

  /**
   * Создаёт читатель существующего соединения без его открытия или передачи владения.
   */
  constructor(db: ProjectDatabase) {
    this.db = db;
    this.entities = new EntityService(db);
  }

  /**
   * Разрешает ID, ключ или типизированную ссылку сессии и проверяет её сохранённые данные.
   */
  session(ref: string): HistorySession {
    return decodeHistorySession(this.entities.get(ref, "work-session"));
  }

  /**
   * Разрешает ссылку материала и проверяет его append-only контракт.
   */
  checkpoint(ref: string): HistoryCheckpoint {
    return decodeHistoryCheckpoint(this.entities.get(ref, "work-checkpoint"));
  }

  /**
   * Загружает и декодирует все сессии проекта; согласованным снимком владеет вызывающий сценарий.
   */
  sessions(): HistorySession[] {
    return this.db.list("work-session").map(decodeHistorySession);
  }

  /**
   * Загружает и декодирует все материалы проекта; повреждение любой записи отклоняет выборку.
   */
  checkpoints(): HistoryCheckpoint[] {
    return this.db.list("work-checkpoint").map(decodeHistoryCheckpoint);
  }

  /**
   * Фильтрует все декодированные сессии одного снимка и возвращает новые записи первыми.
   * Фильтры ограничивают выдачу, но не объём чтения БД.
   */
  list(filters: unknown): HistorySession[] {
    return this.db.snapshot(() => {
      const input = historyFilters(filters);
      const parentId =
        typeof input.parent === "string" ? this.session(input.parent).id : input.parent;
      return this.sessions()
        .filter((session) => matchesHistorySession(session, input, parentId))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    });
  }

  /**
   * Возвращает материалы одной сессии или проекта в хронологическом порядке одного снимка.
   * Перед фильтрацией проверяется полный набор материалов проекта.
   */
  history(ref?: string): HistoryCheckpoint[] {
    return this.db.snapshot(() => {
      const sessionId = ref === undefined ? undefined : this.session(ref).id;
      return sortHistoryCheckpoints(
        this.checkpoints().filter(
          (entry) => sessionId === undefined || entry.data.sessionId === sessionId,
        ),
      );
    });
  }

  /**
   * Возвращает корень и потомков в ширину из одного полного снимка сессий; цикл даёт CONFLICT.
   */
  tree(ref: string): HistorySession[] {
    return this.db.snapshot(() => historySubtree(this.session(ref), this.sessions()));
  }

  /**
   * Возвращает открытые намерения сессии либо её дерева в хронологическом порядке.
   * Все материалы читаются один раз в общем снимке сессий и их потомков.
   */
  intents(ref: string, options: HistoryIntentsOptions = {}): HistoryCheckpoint[] {
    return this.db.snapshot(() => {
      const includeChildren =
        options.includeChildren === undefined ? false : options.includeChildren;
      if (typeof includeChildren !== "boolean") {
        invalidHistoryInput(historyInputMessages.includeChildrenBooleanRequired);
      }
      const session = this.session(ref);
      const selectedSessions = includeChildren
        ? historySubtree(session, this.sessions())
        : [session];
      const sessionIds = new Set(selectedSessions.map((entry) => entry.id));
      const checkpoints = this.checkpoints().filter((entry) =>
        sessionIds.has(entry.data.sessionId),
      );
      return openHistoryIntents(sortHistoryCheckpoints(checkpoints));
    });
  }

  /**
   * Собирает сессию, её материалы, намерения и прямых детей в одном согласованном снимке.
   * Материалы и полный набор сессий загружаются по одному разу; результаты не ограничены страницей.
   */
  context(ref: string): HistoryContext {
    return this.db.snapshot(() => {
      const session = this.session(ref);
      const checkpoints = sortHistoryCheckpoints(
        this.checkpoints().filter((entry) => entry.data.sessionId === session.id),
      );
      return {
        session,
        checkpoints,
        intents: openHistoryIntents(checkpoints),
        children: this.sessions().filter((entry) => entry.data.parentSessionId === session.id),
      };
    });
  }

  /**
   * Разрешает ссылки общим читателем и создаёт снимки названий в текущей транзакции.
   * Разные адреса одной записи запрещены; повреждение любой цели прерывает всю запись материала.
   */
  references(references: readonly string[]): HistoryReference[] {
    const ids = new Set<string>();
    const reader = new EntityReader(this.db);
    return references.map((reference) => {
      const target = reader.get(reference);
      if (ids.has(target.id)) {
        invalidHistoryInput(historyInputMessages.duplicateReference);
      }
      ids.add(target.id);
      return {
        id: target.id,
        kind: target.kind,
        key: target.key,
        title: historyReferenceTitle(target),
      };
    });
  }

  /**
   * Разрешает принимаемых детей, отклоняя ключи и типизированные адреса вместо постоянных ID.
   */
  acceptedSessions(ids: readonly string[]): HistorySession[] {
    return ids.map((id) => {
      const child = this.session(id);
      if (child.id !== id) {
        invalidHistoryInput(historyInputMessages.acceptedIdRequired);
      }
      return child;
    });
  }

  /**
   * Копирует пользователя участия, создавшего pending-ребёнка, а не текущего участия родителя.
   * Отсутствие пользователя сохраняется как null; потерянный создатель даёт CONFLICT.
   */
  inheritedOperator(session: Readonly<HistorySession>): HistoryOperator | null {
    const parentId = session.data.parentSessionId;
    if (parentId === null) {
      historyConflict(historyStateMessages.creatorRunMissing);
    }
    const parent = this.session(parentId);
    const creator = parent.data.runs.find((entry) => entry.id === session.data.createdByRunId);
    if (!creator) {
      historyConflict(historyStateMessages.creatorRunMissing);
    }
    return creator.operator === null ? null : { ...creator.operator, source: "inherited" };
  }
}
