import type { DocumentData, EntityKind, HttpEntityQuery } from "@relay/contracts";

/**
 * Представление карточки для сохранённой разметки каталога; не wire DTO.
 */
export interface EntitySummary {
  /* Постоянная типизированная ссылка Core. */
  ref: { kind: EntityKind; id: string };
  /* Текущий читаемый ключ. */
  key: string;
  /* Заголовок карточки. */
  title: string;
  /* Краткое описание без загрузки текста потребителем. */
  summary: string;
  /* Уточнение контекста, если конкретная проекция его предоставляет. */
  context?: string;
  /* Исходная ревизия содержания. */
  revision: number;
  /* Сохранённое состояние; отсутствует у требований. */
  status?: string;
  /* Доступность цели выбора: у реализации — сохранённый active, у остальных видов true. */
  active: boolean;
  /* Метаданные библиотеки, только для документа. */
  document?: {
    kind: DocumentData["documentKind"];
    status: DocumentData["documentStatus"];
    sectionId: string | null;
    pinned: boolean;
    updatedAt: string;
    linkCount: number;
    excerpt?: string;
  };
}

/**
 * Параметры каталога старой разметки; version передаёт generation текущего API.
 */
export type EntitiesQuery = Partial<Pick<HttpEntityQuery, "offset" | "limit" | "sort">> & {
  /* Текст поиска Core. */
  q?: string;
  /* Отсутствие вида выбирает последовательный каталог доступных видов. */
  kind?: EntityKind;
  /* Поколение исходного окна, без автоматического обновления. */
  version?: string;
  /* Явный адресный набор для названий прикреплений; пустой набор не читает каталог. */
  refs?: readonly string[];
  /* Фильтр сохранённого состояния Core. */
  status?: string;
  /* Фильтры библиотеки. */
  documentKind?: DocumentData["documentKind"];
  section?: string;
  pinned?: "true" | "false";
  archived?: "true" | "false";
  target?: string;
  /* Фильтры реализаций. */
  active?: "true" | "false";
  application?: string;
  feature?: string;
  scenario?: string;
};

/**
 * Окно каталога; счётчики библиотеки отсутствуют, когда API их не предоставляет.
 */
export interface EntitiesPage {
  /* Карточки текущего окна. */
  items: EntitySummary[];
  /* Число совпадений до окна. */
  total: number;
  /* Продолжение либо конец выдачи. */
  nextOffset: number | null;
  /* Generation всех участвовавших чтений. */
  version: string;
  /* Необязательные реальные агрегаты библиотеки. */
  libraryCounts?: Record<string, number>;
}
