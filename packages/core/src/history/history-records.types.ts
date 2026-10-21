import type {
  HistoryCheckpoint,
  HistoryCheckpointAction,
  HistoryReference,
  HistoryRun,
  HistorySession,
} from "@relay/contracts";
import type { HistoryCheckpointValues } from "./history-input.types";

/**
 * Автор и единое время создания записей внутри одной операции истории.
 */
export interface HistoryRecordMetadata {
  /* Проверенный автор операции, сохраняемый дословно. */
  readonly actor: string;
  /* Время операции в ISO 8601; одинаково для связанных записей. */
  readonly now: string;
}

/**
 * Начальное состояние открытой корневой сессии с уже созданным первым участием.
 */
export interface HistoryRootInitialization {
  /* Корень сразу открыт и принадлежит первому участию. */
  readonly status: "open";
  /* Первое участие, чей ID уже зарезервирован фабрикой. */
  readonly run: HistoryRun;
}

/**
 * Происхождение pending-ребёнка; до attach у него нет собственного участия.
 */
export interface HistoryChildInitialization {
  /* Дочернее поручение ожидает первого подключения. */
  readonly status: "pending";
  /* Постоянный ID родительской сессии. */
  readonly parentSessionId: string;
  /* Постоянный ID открытого намерения родителя, из которого создан ребёнок. */
  readonly originCheckpointId: string;
  /* Постоянный ID участия родителя, создавшего ребёнка. */
  readonly createdByRunId: string;
}

/**
 * Варианты первоначального состояния без произвольной частичной мутации данных сессии.
 */
export type HistorySessionInitialization = HistoryRootInitialization | HistoryChildInitialization;

/**
 * Проверенные основания создания append-only материала из одного снимка операции.
 */
export interface HistoryCheckpointCreation {
  /* Действие определяет kind нового материала; существующий intent не изменяется. */
  readonly action: HistoryCheckpointAction;
  /* Проверенное содержание и ссылки исходного ввода. */
  readonly values: HistoryCheckpointValues;
  /* Сессия до повышения ревизии; её следующая ревизия записывается в материал. */
  readonly session: Readonly<HistorySession>;
  /* Проверенное текущее участие, владеющее записью. */
  readonly run: Readonly<HistoryRun>;
  /* Постоянный ID исходного intent; null только при открытии нового намерения. */
  readonly intentId: string | null;
  /* Материалы снимка для вычисления следующего sequence внутри сессии. */
  readonly materials: readonly HistoryCheckpoint[];
  /* Разрешённые снимки целей в порядке ввода; каждая цель уникальна. */
  readonly references: readonly HistoryReference[];
}
