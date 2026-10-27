import type { ComponentPropsWithoutRef, Ref } from "react";
import type { TaskSummary } from "domains/board-tasks";
import type { ProductTargetPreview } from "domains/product";

/** Внешние размеры поднятой карточки в CSS-пикселях. */
export type TaskCardSize = {
  /** Ширина вместе с рамкой. */
  width: number;
  /** Высота вместе с рамкой. */
  height: number;
};

/** Данные карточки и точка её открытия. */
export type TaskCardParams = {
  /** Сводка задачи. */
  task: TaskSummary;
  /** Первая цель реализации. */
  target: ProductTargetPreview | undefined;
  /** Состояние чтения названия цели. */
  targetState: "loading" | "ready" | "error";
  /** Версия порядка задач. */
  version: string;
  /** Место вставки перед карточкой. */
  isTarget: boolean;
  /** Место вставки после карточки. */
  isAfterTarget: boolean;
  /** Следующая задача, включая границу страницы. */
  nextId: string | null | undefined;
  /** Сохранение блокирует повторный перенос. */
  isDisabled: boolean;
  /** Карточка резервирует место поднятой задачи. */
  isPlaceholder: boolean;
  /** Измеренные размеры места вставки. */
  placeholderSize: TaskCardSize | undefined;
  /** Открывает задачу. */
  onOpen: (id: string) => void;
};
/** Атрибуты корневого элемента, не управляемые карточкой. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"article">, "children" | "onClick" | "onMouseDown">;
/** Сортируемая карточка задачи. */
export type TaskCardProps = RootAttrs & TaskCardParams;

/** Общее представление карточки и её неинтерактивной копии при переносе. */
export type TaskCardPreviewProps = RootAttrs & {
  /** Снимок задачи. */
  task: TaskSummary;
  /** Снимок первой цели. */
  target: ProductTargetPreview | undefined;
  /** Состояние чтения цели на момент отображения. */
  targetState: TaskCardParams["targetState"];
  /** Неинтерактивное превью без повторной регистрации sortable. */
  isOverlay?: boolean;
  /** Скрытое содержимое места вставки. */
  isPlaceholder?: boolean;
  /** Запрет повторного переноса во время записи. */
  isDisabled?: boolean;
  /** Регистрация оригинала в sortable. */
  nodeRef?: Ref<HTMLElement>;
  /** Регистрация ручки захвата. */
  handleRef?: Ref<HTMLButtonElement>;
  /** Атрибуты и события сенсора ручки. */
  handleProps?: ComponentPropsWithoutRef<"button">;
  /** Начало мышиного жеста с поверхности. */
  onMouseDown?: ComponentPropsWithoutRef<"article">["onMouseDown"];
  /** Открытие оригинала. */
  onOpen?: (id: string) => void;
};
