import type { HistoryCheckpoint, HistoryCheckpointAction, HistorySession } from "@relay/contracts";
import type { HistorySource, SessionAction } from "domains/history";

/**
 * Параметры формы начала или перехода сессии.
 */
export interface SessionFormProps extends HistoryFormLifecycle {
  /* Исходная сессия; отсутствие допустимо для start. */
  readonly source?: HistorySource;
  /* Явно выбранное действие. */
  readonly action: SessionAction;
  /* Исходное открытое намерение для fork. */
  readonly intent?: HistoryCheckpoint;
}
/**
 * Поля человека для сессии; нужный поднабор определяется действием.
 */
export interface SessionValues {
  /* Заголовок новой корневой или дочерней сессии. */
  title: string;
  /* Необязательное описание; пустой ввод не передаётся в Core. */
  description: string;
  /* Обоснование подключения или приостановки. */
  reason: string;
  /* Результат завершения или причина отмены. */
  result: string;
}
/**
 * Параметры добавления неизменяемого материала.
 */
export interface CheckpointFormProps extends HistoryFormLifecycle {
  /* Исходная сессия-владелец ревизии. */
  readonly source: HistorySource;
  /* Явный вид записи. */
  readonly action: HistoryCheckpointAction;
  /* Намерение для продолжения; отсутствует только при open. */
  readonly intent?: HistoryCheckpoint;
  /* Прямые дети из серверного контекста для выбора принимаемых результатов. */
  readonly children: readonly HistorySession[];
}
/**
 * Жизненный цикл формы отделяет сворачивание от подтверждённого завершения операции.
 */
export interface HistoryFormLifecycle {
  /* Видимость Modal; закрытая форма сохраняет доступную проверку receipt. */
  readonly opened: boolean;
  /* Сворачивает форму без удаления input draft и исходного editor. */
  readonly onClose: () => void;
  /* Открывает исходный редактор независимо от нового статуса сессии или intent. */
  readonly onOpen: () => void;
  /* Удаляет экранный выбор после подтверждённого результата или допустимого discard. */
  readonly onComplete: () => void;
}
/**
 * Поля редактора материала, включая незаполненные необязательные тексты.
 */
export interface CheckpointValues {
  /* Однострочное название материала. */
  title: string;
  /* Основной Markdown-текст. */
  body: string;
  /* Необязательная сводка. */
  summary: string;
  /* Выполненные действия. */
  done: string;
  /* Незавершённая работа. */
  remaining: string;
  /* Рекомендуемое продолжение. */
  nextStep: string;
  /* Выполненные проверки. */
  checks: string;
  /* Постоянные ID выбранных предметных ссылок. */
  references: string[];
  /* ID завершённых детей исходного намерения. */
  acceptedSessionIds: string[];
}
/**
 * Сохранённый ввод материала с исходными владельцем, действием и намерением.
 */
export interface CheckpointDraft {
  /* Исходная сессия, чьи CAS и переносимый токен принадлежат операции. */
  readonly source: HistorySource;
  /* Явно выбранный вид нового материала. */
  readonly action: HistoryCheckpointAction;
  /* Исходный intent; undefined у открытия нового намерения. */
  readonly intent: HistoryCheckpoint | undefined;
  /* Пользовательские поля, переживающие закрытие диалога и смену проекта. */
  readonly values: CheckpointValues;
}
/**
 * Карточка неизменяемого материала; допускает переход в его рабочую сессию.
 */
export interface CheckpointCardProps {
  /* Проверенный сервером материал со снимками ссылок. */
  readonly checkpoint: HistoryCheckpoint;
}
/**
 * Плоское дерево в серверном порядке обхода в ширину.
 */
export interface SessionTreeProps {
  /* Корень и его потомки из одного snapshot Core. */
  readonly sessions: readonly HistorySession[];
}
