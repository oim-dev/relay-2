import type { EntityRecord, HistoryCheckpointInput } from "@relay/contracts";
import type { ProjectDatabase } from "@relay/storage";

/**
 * Файловая SQLite одного теста; всеми открытыми соединениями владеет fixture.
 */
export interface HistoryDatabaseFixture {
  /* Основное соединение с изолированной базой истории. */
  readonly db: ProjectDatabase;

  /* Абсолютный путь к файлу SQLite для внедрения отказа и повторного открытия. */
  readonly path: string;

  /* Новое независимое соединение с той же базой; закрывается при очистке fixture. */
  readonly connect: () => ProjectDatabase;
}

/**
 * Сохранённые строки истории и поколение для проверки полного отката её мутаций.
 * Чтение через Storage сохраняет намеренно повреждённые данные без предметного декодирования.
 */
export interface HistoryStorageSnapshot {
  /* Все сессии, включая ревизии и снимки участия. */
  readonly sessions: readonly EntityRecord[];

  /* Все материалы, включая исходные намерения и их продолжения. */
  readonly checkpoints: readonly EntityRecord[];

  /* Поколение БД в том же согласованном снимке. */
  readonly generation: number;
}

/**
 * Значимые дополнения материала; автор, runId и ревизия всегда берутся из переданной сессии.
 */
export type HistoryMaterialReferences = {
  readonly [
    Field in keyof Pick<HistoryCheckpointInput, "references" | "acceptedSessionIds">
  ]: Readonly<HistoryCheckpointInput[Field]>;
};

/**
 * Независимый вариант внешнего ввода с названием, видимым при отказе теста.
 */
export interface HistoryInputCase<T = unknown> {
  /* Условие и ожидаемый результат отдельного теста. */
  readonly name: string;

  /* Значение до проверки сервисом; изменяемые объекты копируются для каждого теста. */
  readonly input: T;
}
