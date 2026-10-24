import type { GitSyncResponse } from "@relay/contracts";
import type { RuntimeOptions } from "@relay/project-runtime";
import type { GitCounts } from "../transport/repository.types";
import type { SYNC_PHASES } from "./state.constants";

/**
 * Локальное подключение физической базы; никогда не публикуется в Git.
 */
export interface SyncConfiguration {
  /* Версия локального формата. */
  readonly version: 1;
  /* Постоянный ID проекта, проверяемый перед обменом. */
  readonly projectId: string;
  /* Реальный путь базы, общий для workspace aliases и symlink. */
  readonly databasePath: string;
  /* Явный физический конфиг для повторного открытия, без workspace alias. */
  readonly configPath: string;
  /* Абсолютный RELAY_HOME для стандартного пути БД. */
  readonly home: string;
  /* Зафиксированный remote URL или абсолютный путь. */
  readonly remote: string;
  /* Одна общая ветка данных. */
  readonly branch: string;
  /* manual запрещает фоновую сеть, auto включает polling независимо от локальных записей. */
  readonly mode: "manual" | "auto";
  /* Сохранённое желание пользователя; crash не переводит running в stopped. */
  readonly desired: "running" | "stopped";
  /* Локальный CAS предпочтений; stop/disable отменяет ещё не завершённый start без потери своего решения. */
  readonly controlRevision: number;
}

/**
 * Сохранённая наблюдаемость транспорта; не участвует в предметном выборе победителя.
 */
export interface SyncProgress {
  /* ID SQLite-реплики, которой принадлежит cursor; null у файлов прежнего формата. */
  publicationReplicaId: string | null;
  /* Физическая БД cursor; null до привязки engine к очереди. */
  publicationDatabaseIdentity: string | null;
  /* Sequence последнего завершённого окна; 0 начинает новый обход, не означает пустой outbox. */
  afterSequence: number;
  /* Последнее bounded окно с явным исходом; null до prepare либо при смене очереди. */
  publicationWindow: PublicationWindow | null;
  /* Текущая фаза; сохранённая busy-фаза при отсутствии worker не означает живой процесс. */
  phase: (typeof SYNC_PHASES)[number];
  /* Случайный ID сетевой попытки, null до первого цикла. */
  attemptId: string | null;
  /* Реальные Git counts и refs, обновляемые только владельцем сетевого цикла, без Git при status. */
  git: GitCounts;
  /* Remote head последнего предметного пересчёта конфликтов; null при пустой/неизвестной ветке. */
  conflictsHead: string | null;
  /* Поколение локальных данных при пересчёте материалов; null до первого пересчёта. */
  conflictsGeneration: number | null;
  /* Время предметного пересчёта; отдельный refresh не меняет эту отметку. */
  conflictsObservedAt: string | null;
  /* Последний prepare рассмотрел весь outbox либо accept проверил полный overlay; false у старого cache. */
  conflictsComplete: boolean;
  /* Последний успешный fetch ISO, null до первого. */
  lastFetch: string | null;
  /* Последнее подтверждённое применение/подтверждение Git ISO. */
  lastSuccess: string | null;
  /* Начало последнего сетевого цикла ISO. */
  lastAttempt: string | null;
  /* Фактически запланированная следующая попытка ISO, null без таймера. */
  nextRetry: string | null;
  /* Поколение последнего материализованного кандидата, null до первого. */
  exportedGeneration: number | null;
  /* Количество changeset в текущем неподтверждённом Git-кандидате. */
  exportedCount: number;
  /* Последняя структурированная ошибка или null после успеха. */
  error:
    | (Extract<GitSyncResponse, { ok: false }>["error"] & {
        /* Время наблюдения отказа ISO. */
        readonly at: string;
        /* Фаза, в которой произошёл отказ. */
        readonly operation: string;
      })
    | null;
}

/**
 * Диагностика одного bounded окна. included ещё не ACK, пока completed=false;
 * deferred относится к моменту подготовки, актуальный остаток читается отдельным status.pending.
 */
export interface PublicationWindow {
  /* Исходный cursor, неизменный на non-FF retry. */
  readonly afterSequence: number;
  /* Cursor для следующей попытки; 0 после конца обхода. */
  readonly nextSequence: number;
  /* После выбранных sources остались более поздние пакеты на момент prepare. */
  readonly hasMore: boolean;
  /* Рассмотренные source IDs в локальном причинном порядке. */
  readonly examined: readonly string[];
  /* Подготовленные к публикации source IDs, без поздних записей. */
  readonly included: readonly string[];
  /* Source IDs этого окна, ожидавшие dependencies; это не конфликты. */
  readonly deferred: readonly string[];
  /* Объём исходных JSON выбранного окна в UTF-8 байтах. */
  readonly sourceBytes: number;
  /* Один атомарный source превышает byte budget. */
  readonly oversized: boolean;
  /* Установлено принятие included либо окно завершено без публикации и без фиктивного ACK. */
  readonly completed: boolean;
}

/**
 * Явная регистрация supervisor, независимая от имён workspace.
 */
export interface RegisteredProject {
  /* Физический путь БД — ключ локальной идентичности worker. */
  readonly databasePath: string;
  /* Контекст с явным конфигом, без project alias. */
  readonly options: RuntimeOptions;
}
