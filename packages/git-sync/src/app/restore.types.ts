import type {
  ProjectLocation,
  ProjectRestorationContext,
  RuntimeOptions,
} from "@relay/project-runtime";
import type { SyncConfiguration } from "../local/state.types";

/**
 * Приватная подготовка одной независимой реплики перед асинхронным worktree preflight.
 */
export interface RestorationPreparationInput {
  /* Уже созданный эксклюзивный каталог; вызывающий удаляет его после завершения restore. */
  readonly directory: string;
  /* Зафиксированный и разрешённый Git remote. */
  readonly remote: string;
  /* Общая ветка без префикса refs/heads/. */
  readonly branch: string;
  /* ID выбранного config/state; undefined только при первом восстановлении без привязки. */
  readonly projectId: string | undefined;
  /* Локальное предпочтение восстановленного проекта, не переносимое содержимое Git. */
  readonly mode: "auto" | "manual";
}

/**
 * Закрытая SQLite и проверенная Git-история в приватном каталоге вызывающего; публичных файлов ещё нет.
 */
export interface PreparedRestoration {
  /* Проверенный постоянный ID проекта. */
  readonly projectId: string;
  /* Новый ID подготовленной SQLite, который сохранится при публикации её точной копии. */
  readonly replicaId: string;
  /* Git commit канонической публикации. */
  readonly head: string;
  /* Bare staging с проверенными объектами и временным ref data; не рабочий транспорт проекта. */
  readonly repository: string;
  /* Закрытый самодостаточный SQLite-файл без внешнего WAL. */
  readonly databasePath: string;
}

/**
 * Проверенный источник restore до fetch; нового projectId и пути БД здесь ещё может не быть.
 */
export interface RestorationSource {
  /* Неизменяемый выбор config/ID до асинхронной подготовки. */
  readonly selected: ProjectRestorationContext;
  /* Физический каталог текущего или будущего config; может ещё не существовать. */
  readonly root: string;
  /* Каталог owner подготовки: state известной БД либо home/.restore/<config hash>. */
  readonly preparationDirectory: string;
  /* Прежнее проверенное подключение либо null, если оно ещё не сохранено. */
  readonly saved: SyncConfiguration | null;
  /* Абсолютный локальный путь либо URL Git-источника. */
  readonly remote: string;
  /* Проверенная общая ветка без refs/heads/. */
  readonly branch: string;
  /* true, если origin текущего Git-контекста должен остаться владельцем URL. */
  readonly inherited: boolean;
}

/**
 * Подготовка конечного Git-транспорта под уже удерживаемым owner выбранной БД.
 */
export interface RestorationTransportInput {
  /* Текущий явно переданный контекст Runtime для повторных guards. */
  readonly options: RuntimeOptions;
  /* Зафиксированный до fetch источник и выбор config. */
  readonly source: RestorationSource;
  /* Физическая цель полученного из snapshot постоянного projectId. */
  readonly location: ProjectLocation;
  /* Закрытая Core-реплика и полностью проверенная история текущего fetch. */
  readonly prepared: PreparedRestoration;
}
