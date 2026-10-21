import { resolve } from "node:path";
import {
  HistoryService,
  KnowledgeService,
  PlanningService,
  QueryService,
  TasksService,
} from "@relay/core";
import { RelayError, type EntityRecord, type WriteOptions } from "@relay/contracts";
import { resolveProject, type ProjectLocation, type RuntimeOptions } from "@relay/project-runtime";
import { ProjectDatabase } from "@relay/storage";
import type { CommandContext } from "gunshi";
import type { ArgumentValues, InputFields } from "../input/arguments.types";
import { CliUsageError } from "../errors/errors";
import { invocationPage, orderEntities } from "./invocation-pagination";
import { registryMessages } from "../locales/registry";
import type { Result } from "../output/output.types";
import type { LocalPageSource, PageSource } from "../pagination/pagination.types";
import type { CliRuntime } from "./runtime.types";

/**
 * Контекст одного обработчика: значения ввода, выбор проекта и ленивое владение соединением БД.
 * Реестр закрывает вызов в finally и удерживает общую транзакцию либо снимок вокруг сценария.
 */
export class Invocation {
  /* Соединение, принадлежащее этому вызову; отсутствует до первого обращения к db. */
  private database?: ProjectDatabase;
  /* Выбранный проект, закреплённый первым обращением к location. */
  private projectLocation?: ProjectLocation;
  /* Неизменяемые значения Gunshi; предметные поля находятся отдельно в input. */
  readonly values: ArgumentValues;
  /* Контекст разбора команды; экземпляр не разделяется между вызовами runCli. */
  readonly context: Readonly<CommandContext>;
  /* Явное окружение и источник stdin данного запуска. */
  readonly runtime: CliRuntime;
  /* Поля после разрешения источников и CLI-алиасов; предметную форму проверяет Core. */
  readonly input: InputFields;

  /**
   * Сохраняет уже разобранные параметры и поля, не выбирая проект и не открывая БД.
   */
  constructor(context: Readonly<CommandContext>, runtime: CliRuntime, input: InputFields) {
    this.context = context;
    this.runtime = runtime;
    this.input = input;
    this.values = context.values;
  }

  /**
   * Возвращает строковое представление параметра; отсутствующее значение представляется пустой строкой.
   */
  text(key: string): string {
    return String(this.values[key] ?? "");
  }

  /**
   * Выбирает автора с приоритетом --actor над RELAY_ACTOR и отвергает отсутствие непустой строки.
   * Значение сохраняется дословно; остальные ограничения автора проверяет предметный сервис.
   */
  get actor(): string {
    const actor = this.values.actor ?? this.runtime.env.RELAY_ACTOR;
    if (typeof actor !== "string" || !actor.trim()) {
      throw new CliUsageError(registryMessages.actorRequired, "ACTOR_REQUIRED");
    }
    return actor;
  }

  /**
   * Передаёт автора и прочитанную ревизию в Core; владелец ревизии определяется конкретным сценарием.
   * Наличие и числовой синтаксис --if-revision проверяет схема update-команды.
   */
  get write(): WriteOptions {
    return { actor: this.actor, ifRevision: Number(this.values["if-revision"]) };
  }

  /**
   * Вычисляет параметры Project Runtime без обращения к файловой системе.
   * CLI имеет приоритет над окружением; относительный RELAY_HOME разрешается от runtime.cwd.
   */
  get options(): RuntimeOptions {
    const config = this.values.config ?? this.runtime.env.RELAY_CONFIG;
    const home =
      this.runtime.env.RELAY_HOME ??
      (this.runtime.env.HOME ? resolve(this.runtime.env.HOME, ".relay") : undefined);
    return {
      cwd: this.runtime.cwd,
      ...(home !== undefined ? { home: resolve(this.runtime.cwd, home) } : {}),
      ...(config !== undefined ? { config: String(config) } : {}),
      ...(this.values.project !== undefined ? { project: this.text("project") } : {}),
    };
  }

  /**
   * Один раз разрешает конфигурацию проекта; справка не обращается к этому свойству.
   */
  get location(): ProjectLocation {
    return (this.projectLocation ??= resolveProject(this.options));
  }

  /**
   * Лениво открывает единственное соединение и сверяет ID с выбранной конфигурацией.
   * При подмене базы закрывает новое соединение до отказа; успешным соединением владеет вызов.
   */
  get db(): ProjectDatabase {
    if (this.database) {
      return this.database;
    }
    const location = this.location;
    const database = ProjectDatabase.open(location.databasePath);
    if (database.projectId !== location.projectId) {
      database.close();
      throw new RelayError("PROJECT_ID_MISMATCH", registryMessages.projectReplaced, 4, {
        databasePath: location.databasePath,
        expected: location.projectId,
        actual: database.projectId,
      });
    }
    this.database = database;
    return database;
  }

  /**
   * Подключает сценарии знаний к общему соединению и транзакции вызова.
   */
  get knowledge(): KnowledgeService {
    return new KnowledgeService(this.db);
  }

  /**
   * Подключает сценарии задач, сохраняя независимый журнал комментариев внутри Core.
   */
  get tasks(): TasksService {
    return new TasksService(this.db);
  }

  /**
   * Подключает сценарии планирования к тому же соединению выбранного проекта.
   */
  get planning(): PlanningService {
    return new PlanningService(this.db);
  }

  /**
   * Подключает историю поручений к транзакции или снимку текущего вызова.
   */
  get history(): HistoryService {
    return new HistoryService(this.db);
  }

  /**
   * Подключает составные чтения проекта, наследующие удерживаемый реестром снимок.
   */
  get queries(): QueryService {
    return new QueryService(this.db);
  }

  /**
   * Закрывает принадлежащее вызову соединение; без обращения к db операция не имеет эффектов.
   * После закрытия вызов не предназначен для повторного выполнения сценариев.
   */
  close(): void {
    this.database?.close();
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
   * Упорядочивает уже вычисленный состав сущностей и выдаёт его страницу в текущем снимке.
   * Исходный массив не меняется; весь состав присутствует в памяти до пагинации.
   */
  entities(items: readonly EntityRecord[]): Result {
    return this.page(orderEntities(items, this.text("sort") || "key"));
  }
}
