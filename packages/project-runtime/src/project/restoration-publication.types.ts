import type { ProjectLocation } from "./location.types";
import type { RestorationFileIdentity } from "./restoration-ownership.types";

/**
 * Точное расположение одной попытки публикации; наличие файлов этим ещё не подтверждается.
 */
interface RestorationPublicationPaths {
  /* Постоянный ID восстанавливаемого проекта. */
  readonly projectId: string;
  /* Точный config, для которого подготовлена публикация. */
  readonly configPath: string;
  /* Точный стандартный либо явно выбранный путь базы. */
  readonly databasePath: string;
  /* Собственный случайный соседний staging-каталог. */
  readonly staging: string;
}

/**
 * Локальное намерение до первого изменения рабочего пути БД. v2 исключает разрушительный recovery
 * старого reader v1; ранний v1 читается только для сохраняющего отказа, без resume и cleanup.
 */
export type RestorationPublication = RestorationPublicationPaths &
  (
    | {
        /* Ранний формат без достаточной идентичности datafile. */
        readonly version: 1;
      }
    | {
        /* Сохраняющий протокол с обязательной физической идентичностью до экспозиции. */
        readonly version: 2;
        /* Исходный datafile, не меняющий идентичность при поздних пользовательских commits. */
        readonly databaseIdentity: RestorationFileIdentity;
      }
  );

/**
 * Явный отказ завершить неопределённую публикацию без потери принятого локального состояния.
 * Наличие intent/hardlink не доказывает неизменность БД: после публикации могли работать другие writers.
 * Результат не подтверждает соответствие БД snapshot текущего запроса и не разрешает удалять её.
 */
export interface RestorationRecoveryDetails {
  /* pending-publication — обнаружена прежняя попытка; publication-failed — отказ текущей публикации. */
  readonly reason: "pending-publication" | "publication-failed";
  /* Намерение подключения, а не обещание наличия либо актуальности config и рабочей БД. */
  readonly location: ProjectLocation;
  /* Путь staging из намерения; наличие и содержимое проверяются отдельно при явном recovery. */
  readonly stagingPath: string;
  /* Путь сохранённого маркера публикации; его содержимое требуется для явного recovery. */
  readonly publicationPath: string;
  /* Callback завершился в этом вызове; отсутствие поздних записей этим не подтверждается. */
  readonly materializedInCurrentCall: boolean;
  /* Исходная ошибка текущей публикации; отсутствует при обнаружении прежнего intent. */
  readonly sourceError?: {
    /* Код Relay либо IO_ERROR для системного исключения; полная причина остаётся в Error.cause. */
    readonly code: string;
    /* Исходное пояснение отказа config/link, без подмены общим сообщением recovery. */
    readonly message: string;
  };
}
