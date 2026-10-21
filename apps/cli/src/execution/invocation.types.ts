import type { CommandContext } from "gunshi";
import type { ProjectLocation, RuntimeOptions } from "@relay/project-runtime";
import type { ArgumentValues } from "../input/arguments.types";

/**
 * Структурный контекст построения страницы, независимый от реализации Invocation и Core.
 * Доступ к location и db может лениво открыть проект; локальный источник их не запрашивает.
 */
export interface InvocationPageContext {
  /* Схемы и полный путь выбранной команды Gunshi. */
  readonly context: Readonly<CommandContext>;
  /* Неизменяемые значения параметров текущего вызова. */
  readonly values: ArgumentValues;
  /* Параметры выбора проекта с уже применённым приоритетом CLI над окружением. */
  readonly options: RuntimeOptions;
  /* Ленивая привязка проекта, закреплённая на время вызова. */
  readonly location: ProjectLocation;
  /* Минимальный доступ к поколению открытой БД; транзакцией владеет реестр. */
  readonly db: PageDatabase;
}

/**
 * Доступ к идентичности и поколению БД, необходимый только для курсора страницы.
 */
export interface PageDatabase {
  /* Постоянный ID проекта из открытой БД. */
  readonly projectId: string;
  /* Путь открытой базы, различающий независимые локальные экземпляры проекта. */
  readonly path: string;

  /**
   * Возвращает поколение из удерживаемого вызывающим кодом снимка.
   */
  getGeneration(): number;
}

/**
 * Упорядоченные параметры предметного запроса без глобальных параметров и окна страницы.
 */
export type PageQueryEntries = readonly (readonly [key: string, value: unknown])[];
