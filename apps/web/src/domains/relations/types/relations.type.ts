import type { EntityIdentity, NamedCommand } from "@relay/contracts";

/**
 * Постоянный адрес текущей сущности, не расширяемый kind старого graph API.
 */
export type EntityRef = Pick<EntityIdentity, "id" | "kind">;

/**
 * Компактное представление карточки для существующего визуализатора.
 */
export interface RelationNode {
  /* Постоянный адрес. */
  ref: EntityRef;
  /* Сохранённое название либо ключ незаполненного продукта/задачи. */
  title: string;
  /* Читаемый ключ. */
  key: string;
  /* Ревизия владельца содержания. */
  revision: number;
  /* Сохранённый статус; пустая строка, если неприменим. */
  status: string;
}

/**
 * Представление структурированного поля Core, не отдельная сущность-ребро.
 */
export interface RelationEdge {
  /* Производный устойчивый ID визуального ребра. */
  id: string;
  /* Семантика сохранённого поля. */
  type: string;
  /* Начало направленного отношения. */
  from: EntityRef;
  /* Конец отношения. */
  to: EntityRef;
  /* Пояснение документа; пустая строка у остальных связей. */
  description: string;
  /* Ревизия сущности-владельца, не ребра. */
  revision: number;
  /* Единственный источник — структурированные DTO текущего Core. */
  source: "structured";
  /* Команда удаления с исходным guard; null у связи со своим предметным редактором. */
  remove: NamedCommand | null;
}

/**
 * Геометрический путь в уже прочитанных отношениях.
 */
export interface RelationExplanation {
  /* Цель пути. */
  target: EntityRef;
  /* Последовательность адресов от корня. */
  nodes: EntityRef[];
  /* ID визуальных рёбер пути. */
  edges: string[];
  /* Ключи в порядке узлов. */
  keys?: string[];
}

/**
 * Окно ограниченного снимка представления.
 */
export interface RelationsPage {
  /* Страница узлов. */
  nodes: RelationNode[];
  /* Страница рёбер. */
  edges: RelationEdge[];
  /* Карточки концов рёбер за окном узлов. */
  endpoints: RelationNode[];
  /* Объяснение включения узлов. */
  paths: RelationExplanation[];
  /* Размер выбранной области до окна. */
  totalNodes: number;
  /* Число отношений до окна. */
  totalEdges: number;
  /* Продолжение; null после последней страницы. */
  nextOffset: number | null;
  /* Адреса на границе глубины. */
  boundary: EntityRef[];
  /* Есть соседи за глубиной. */
  depthLimited: boolean;
  /* generation исходного чтения. */
  version: string;
}

/**
 * Согласованный полный контекст в пределах явного бюджета чтения.
 */
export interface EntityContext {
  /* Разрешённый постоянный адрес корня. */
  root: EntityRef;
  /* Строковое поколение. */
  version: string;
  /* Все узлы связной компоненты. */
  nodes: RelationNode[];
  /* Все её сохранённые связи. */
  edges: RelationEdge[];
  /* Бюджет отклоняется ошибкой, усечённый успех запрещён. */
  complete: true;
}

/**
 * Только параметры представления существующих связей.
 */
export interface RelationsQuery {
  /* Пользовательский адрес, разрешаемый Core. */
  root?: string;
  /* Фильтр семантики. */
  type?: string;
  /* Направление обхода. */
  direction?: "both" | "outgoing" | "incoming";
  /* Число шагов геометрии. */
  depth?: number;
  /* Совместимое имя представления. */
  profile?: "all" | "context";
  /* Поиск по подписям. */
  q?: string;
  /* Смещение окна. */
  offset?: number;
  /* Размер окна. */
  limit?: number;
  /* Исходное поколение. */
  version?: string;
}

/**
 * UI-ввод существующей предметной операции, не произвольная мутация графа.
 */
export type RelationOperation =
  | {
      /* Добавление поддерживаемого структурированного отношения. */
      readonly action: "add";
      /* Адрес владельца, разрешаемый Core. */
      readonly from: string | EntityRef;
      /* Адрес целевой сущности. */
      readonly to: string | EntityRef;
      /* Поддерживаемая семантика поля владельца. */
      readonly type: string;
      /* Пояснение только для отношений документа. */
      readonly description: string;
    }
  | {
      /* Отзыв существующего поддерживаемого отношения. */
      readonly action: "remove";
      /* Производный ID прочитанного ребра. */
      readonly id: string;
    };

/**
 * Подготовка и доставляемый исход записи до подтверждения действующей формой.
 */
export interface PendingRelationWrite {
  /* Однократно подготовленные исходные команды; параллельные вызовы разделяют подготовку. */
  commands: Promise<readonly NamedCommand[]>;
  /* Выполняющийся либо подтверждённый исход до acknowledgement активной формы. */
  outcome?: Promise<void> | undefined;
}
