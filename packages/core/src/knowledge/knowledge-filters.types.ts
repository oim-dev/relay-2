import type {
  ApplicationData,
  DocumentData,
  EntityPageRequest,
  ImplementationData,
} from "@relay/contracts";

/**
 * Проверенный ссылочный фильтр, ещё не разрешённый в постоянный ID.
 */
export interface KnowledgeReferenceFilter {
  /* Вид цели определяет сохраняемое поле applicationId, featureId или scenarioId. */
  readonly kind: "application" | "feature" | "scenario";
  /* Пользовательская ссылка, включая ключ, алиас и квалифицированный адрес. */
  readonly ref: string;
}

/**
 * Проверенные фильтры списка; отсутствующее поле не ограничивает выдачу.
 */
export interface KnowledgeFilters {
  /* Подстрока в нижнем регистре для поиска по адресам и текстам. */
  readonly query?: string;
  /* Порядок выдачи; по умолчанию key. */
  readonly sort: EntityPageRequest["sort"];
  /* Ссылочные ограничения в порядке application, feature, scenario. */
  readonly references: readonly KnowledgeReferenceFilter[];
  /* Пользовательская ссылка на цель отношения или реализации. */
  readonly target?: string;
  /* Признак активного участия. */
  readonly active?: boolean;
  /* Признак закреплённого документа. */
  readonly pinned?: boolean;
  /* Тип приложения. */
  readonly type?: ApplicationData["type"];
  /* Предметный вид документа. */
  readonly documentKind?: DocumentData["documentKind"];
  /* Статус документа либо реализации, проверенный для выбранного вида. */
  readonly status?: DocumentData["documentStatus"] | ImplementationData["status"];
  /* true выбирает архивные документы, false исключает их. */
  readonly archived?: boolean;
  /* ID эффективного раздела; null выбирает документы вне разделов. */
  readonly sectionId?: string | null;
}

/**
 * Ограничение по уже разрешённой ссылке; постоянный ID сравнивается без повторного чтения БД.
 */
export interface KnowledgeReferenceConstraint {
  /* Вид определяет поле связи в записи. */
  readonly kind: KnowledgeReferenceFilter["kind"];
  /* Постоянный ID выбранного приложения, фичи или сценария. */
  readonly id: string;
}

/**
 * Фильтры одного согласованного снимка с разрешёнными постоянными ID.
 */
export interface ResolvedKnowledgeFilters extends Omit<KnowledgeFilters, "references" | "target"> {
  /* Ссылочные ограничения без пользовательских адресов. */
  readonly references: readonly KnowledgeReferenceConstraint[];
  /* Постоянный ID цели отношения или реализации; отсутствие не ограничивает цель. */
  readonly targetId?: string;
}
