import type { ProjectLocation } from "./location.types";
import type { RestorationCleanupFailure } from "./restoration-ownership.types";

/**
 * Оставшиеся recovery-материалы после успешной привязки, если доказанную очистку завершить не удалось.
 */
export interface RestorationResumeRecovery {
  /* Сохранённый путь intent; отдельные файлы могут уже отсутствовать после частичной уборки. */
  readonly publicationPath: string;
  /* Private staging, который нельзя удалять рекурсивно без повторной проверки его содержимого. */
  readonly stagingPath: string;
  /* Причина сохранения материалов; не маскируется успешной привязкой проекта. */
  readonly failure: RestorationCleanupFailure;
}

/**
 * Явно подключённый сохранённый локальный проект, а не материализация нового fetched snapshot.
 * Существующие данные, replicaId, outbox и поздние commits не заменяются; remote ack не выполняется.
 */
export interface RestorationResumeResult {
  /* Проверенное расположение сохранённой базы и совпадающего config. */
  readonly location: ProjectLocation;
  /* true означает завершённую явную привязку; отсутствие intent даёт RESTORE_NOT_PENDING. */
  readonly resumed: true;
  /* Сохранён существующий datafile и его локальный остаток, без bootstrap/пересоздания. */
  readonly preservedExisting: true;
  /* Runtime не хранит Git HEAD и не выводит его из файлов; исходный checkpoint неизвестен. */
  readonly sourceCheckpoint: null;
  /* null после полной уборки; иначе привязка успешна, но recovery-материалы сохранены. */
  readonly recovery: RestorationResumeRecovery | null;
}
