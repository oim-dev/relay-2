import {
  HistoryService,
  KnowledgeService,
  PlanningService,
  QueryService,
  TasksService,
} from "@relay/core";
import type { CommandExecutionContext, CommandWriteOptions, EntityRecord } from "@relay/contracts";
import { openProject, type OpenedProject, type ProjectLocation } from "@relay/project-runtime";
import type { ProjectDatabase } from "@relay/storage";
import type { CommandContext } from "gunshi";
import type { InputFields } from "../input/arguments.types";
import { invocationPage, orderEntities } from "./invocation-pagination";
import { LocalInvocation } from "./local-invocation";
import type { Result } from "../output/output.types";
import type { LocalPageSource, PageSource } from "../pagination/pagination.types";
import type { CliRuntime } from "./runtime.types";
import { readVersionPrecondition } from "../input/version-precondition";

/**
 * Контекст одного обработчика: значения ввода, выбор проекта и ленивое владение соединением БД.
 * Реестр закрывает вызов после await/finally; записью владеет Core executor, async read — anchor Core.
 * Обычные синхронные чтения сохраняют согласованный snapshot.
 */
export class Invocation extends LocalInvocation {
  /* Проверенный проект с рабочим соединением; отсутствует до первого обращения к db или location. */
  private openedProject?: OpenedProject;
  /* Прочитанные клиентом guards только writer; undefined оставляет чтение без execution context. */
  readonly commandExecution: CommandExecutionContext | undefined;

  /**
   * Сохраняет уже разобранные параметры и поля, не выбирая проект и не открывая БД.
   */
  constructor(
    context: Readonly<CommandContext>,
    runtime: CliRuntime,
    input: InputFields,
    commandExecution?: CommandExecutionContext,
  ) {
    super(context, runtime, input);
    this.commandExecution = commandExecution;
  }

  /**
   * Передаёт только предъявленные локальное/переносимое предусловия и автора.
   * Отсутствующую локальную ревизию не вычисляет и не подменяет; владельца проверяет Core.
   */
  get write(): CommandWriteOptions {
    return { actor: this.actor, ...readVersionPrecondition(this.values) };
  }

  /**
   * Один раз выбирает и открывает проект через Runtime, принимая владение рабочим соединением.
   * db и location разделяют этот результат независимо от порядка первого обращения.
   */
  private get project(): OpenedProject {
    return (this.openedProject ??= openProject(this.options));
  }

  /**
   * Возвращает расположение, проверенное тем же открытием, которым пользуется db.
   * Справка и локальные конфигурационные команды не обращаются к этому свойству.
   */
  get location(): ProjectLocation {
    return this.project.location;
  }

  /**
   * Возвращает единственное соединение вызова; его совместимость и ID уже проверены Runtime.
   */
  get db(): ProjectDatabase {
    return this.project.database;
  }

  /**
   * Подключает знания к соединению проекта; асинхронные записи используют его CommandStore.
   */
  get knowledge(): KnowledgeService {
    return new KnowledgeService(this.db, this.commandExecution);
  }

  /**
   * Подключает сценарии задач, сохраняя независимый журнал комментариев внутри Core.
   */
  get tasks(): TasksService {
    return new TasksService(this.db, this.commandExecution);
  }

  /**
   * Подключает сценарии планирования к тому же соединению выбранного проекта.
   */
  get planning(): PlanningService {
    return new PlanningService(this.db, this.commandExecution);
  }

  /**
   * Подключает историю поручений; записи используют async executor, чтения наследуют снимок CLI.
   */
  get history(): HistoryService {
    return new HistoryService(this.db, this.commandExecution);
  }

  /**
   * Подключает sync-чтения в снимке CLI и async versioned-reader с собственным anchor Core.
   */
  get queries(): QueryService {
    return new QueryService(this.db);
  }

  /**
   * Закрывает принадлежащее вызову соединение; без обращения к db/location не имеет эффектов.
   * После закрытия вызов не предназначен для повторного выполнения сценариев.
   */
  close(): void {
    this.openedProject?.database.close();
  }

  /**
   * Формирует страницу внутри снимка реестра; local-source позволяет обойтись без проектной БД.
   * Ленивый источник ограничивает чтение окном, массив ограничивает только объём выдачи.
   */
  page<T>(
    items: PageSource<T>,
    extra: Readonly<Record<string, unknown>> = {},
    source?: LocalPageSource,
  ): Result {
    return invocationPage(this, items, extra, source);
  }

  /**
   * Проверяет курсор до вызова ленивого читателя, затем сортирует и ограничивает состав.
   * Читатель выполняется один раз в снимке команды; неверный курсор не запускает поиск.
   * Готовый массив также допустим. Успешная страница пока вычисляет весь состав в памяти.
   */
  entities(source: readonly EntityRecord[] | (() => readonly EntityRecord[])): Result {
    return this.page((window) => {
      const records = typeof source === "function" ? source() : source;
      const ordered = orderEntities(records, this.text("sort") || "key");
      return {
        total: ordered.length,
        items: ordered.slice(window.offset, window.offset + window.limit),
      };
    });
  }
}
