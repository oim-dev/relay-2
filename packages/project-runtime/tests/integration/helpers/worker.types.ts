import type { Subprocess } from "bun";
import type { ProjectLocation, RuntimeOptions } from "@relay/project-runtime";

/**
 * Параметры отдельного процесса инициализации с дополнительной проверкой изоляции HOME.
 */
export interface InitializationWorkerInput extends RuntimeOptions {
  /* Ожидаемый homedir() процесса; отсутствие отключает только проверку HOME. */
  readonly expectedHome?: string;
  /* При true барьер ready наступает после создания базы, до публикации конфига. */
  readonly synchronizePublication?: boolean;
}

/**
 * Параметры участника гонки регистраций или непрерывного читателя workspace.
 */
export interface RegistrationWorkerInput extends RuntimeOptions {
  /* Явный путь workspace, включая его символьную ссылку. */
  readonly config: string;
  /* Путь проверенного проекта для добавляемых регистраций. */
  readonly target: string;
  /* Префикс независимого набора имён участника. */
  readonly prefix: string;
  /* Число синхронизированных операций записи; положительное целое. */
  readonly count: number;
  /* Добавление, удаление либо чтение JSON до сообщения stop. */
  readonly action: "register" | "unregister" | "read";
}

/**
 * Успешная публикация проекта в отдельном процессе.
 */
export interface InitializationSuccess {
  /* Признак успешного завершения init. */
  readonly kind: "success";
  /* Конфиг и база опубликованного проекта. */
  readonly location: ProjectLocation;
}

/**
 * Ожидаемый предметный отказ отдельной попытки init.
 */
export interface InitializationFailure {
  /* Признак отказа Runtime, не ошибки самого worker. */
  readonly kind: "failure";
  /* Стабильный код RelayError, полученный при init. */
  readonly code: string;
}

/**
 * Проверяемый ответ процесса инициализации; kind определяет доступность location или code.
 */
export type InitializationResult = InitializationSuccess | InitializationFailure;

/**
 * Результат завершения worker с полностью прочитанными потоками.
 */
export interface WorkerResult {
  /* Код завершения дочернего процесса. */
  readonly exit: number;
  /* Полный stdout процесса; у писателей workspace должен быть пустым. */
  readonly stdout: string;
  /* Полный stderr процесса; успешный worker не пишет диагностики. */
  readonly stderr: string;
}

/**
 * Запущенный worker, которым владеет RuntimeFixture.
 */
export interface RunningWorker {
  /* Процесс с IPC и непрерывно читаемыми stdout/stderr. */
  readonly child: Subprocess<"pipe", "pipe", "pipe">;
  /* Завершение процесса вместе с полным чтением обоих потоков. */
  readonly result: Promise<WorkerResult>;
}
