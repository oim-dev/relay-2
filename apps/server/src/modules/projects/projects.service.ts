import { realpathSync, statSync } from "node:fs";
import { Inject, Injectable } from "@nestjs/common";
import {
  RelayError,
  validateActor,
  type ServerContext,
  type ServerProjectStatus,
} from "@relay/contracts";
import {
  hasProjectGit,
  openProject,
  resolveServerScope,
  synchronizationDueAt,
  type OpenedProject,
} from "@relay/project-runtime";
import { dirname } from "node:path";
import type { ProjectDatabase } from "@relay/storage";
import type { RelayServerOptions } from "../../server.types";
import { SERVER_OPTIONS } from "../../http/options";
import { httpMessages } from "../../http/http.messages";
import { publicError } from "../../http/errors";
import type { ProjectTarget } from "./project.types";
import { AutomaticSynchronization } from "./automatic-synchronization";

/**
 * Идентифицирует физическую БД без зависимости от имени/симлинка файла.
 */
function physicalIdentity(path: string): string {
  const file = statSync(realpathSync(path), { bigint: true });
  return `${file.dev}:${file.ino}:${file.birthtimeNs}`;
}

/**
 * Nest-владелец Runtime scope и коротких SQLite соединений. Core не участвует в DI инфраструктуре.
 * Workspace фиксируется до bind; каждое обращение повторно проверяет физический anchor.
 */
@Injectable()
export class ProjectsService {
  /* Проверенный публичный контекст с сохранёнными недоступными регистрациями. */
  readonly context: ServerContext;
  /* Ready metadata того же bootstrap scope, без повторного выбора регистрации после bind. */
  readonly status: readonly ServerProjectStatus[];
  /* Единственный адрес каждого физического проекта текущего bootstrap. */
  private readonly targets = new Map<string, ProjectTarget>();
  /* Async writers и процессные вызовы, удерживающие открытое соединение. */
  private readonly pending = new Set<Promise<unknown>>();
  /* Фоновый обмен имеет lifetime приложения, а не HTTP-запроса. */
  private readonly synchronization: AutomaticSynchronization;
  /* Закрытие запрещает новые соединения после HTTP drain. */
  private closing = false;

  /**
   * Проверяет область Runtime до listener. Разные физические базы с одним ID отвергает Runtime.
   */
  constructor(
    /* Область проекта и необязательный процессный порт автоматического обмена. */
    @Inject(SERVER_OPTIONS) private readonly options: RelayServerOptions,
  ) {
    validateActor(options.actor);
    this.synchronization = new AutomaticSynchronization(async (error): Promise<void> => {
      await options.synchronizationWarning?.(publicError(error));
    });
    const scope = resolveServerScope(options.runtime);
    this.status = scope.projects.map(({ id, name, slug, path, available, error }) => ({
      id,
      name,
      slug,
      path,
      available,
      ...(error === undefined ? {} : { error }),
    }));
    const { project: _registration, ...base } = options.runtime;
    for (const project of scope.projects) {
      if (project.id !== null && project.location !== null && project.identity !== null) {
        this.targets.set(project.id, {
          projectId: project.id,
          identity: project.identity,
          options: { ...base, config: project.location.configPath },
        });
      }
    }
    this.context = {
      version: options.version,
      mode: scope.scope.kind,
      actor: options.actor,
      projects: scope.projects.map(({ id, name, slug, available, error }) => ({
        id,
        name,
        slug,
        available,
        ...(error === undefined ? {} : { error }),
      })),
    };
  }

  /**
   * Возвращает только адрес зарегистрированной базы, без fallback на первый проект workspace.
   */
  target(projectId: string): ProjectTarget {
    if (this.closing) {
      throw new RelayError("SERVER_CLOSING", httpMessages.closing);
    }
    const target = this.targets.get(projectId);
    if (target === undefined) {
      throw new RelayError("NOT_FOUND", httpMessages.missing, 3);
    }
    return target;
  }

  /**
   * Открывает собственное соединение и сверяет startup anchor; ошибка всегда закрывает его.
   */
  private open(target: ProjectTarget): OpenedProject {
    const project = openProject(target.options);
    try {
      if (
        project.location.projectId !== target.projectId ||
        physicalIdentity(project.location.databasePath) !== target.identity
      ) {
        throw new RelayError("PROJECT_CHANGED", httpMessages.projectChanged, 4);
      }
      return project;
    } catch (error) {
      project.database.close();
      throw error;
    }
  }

  /**
   * Повторно проверяет выбранную БД и durable расписание после очереди, освобождая соединение
   * до ожидания Git. Межпроцессный mutex и окончательное решение о попытке остаются у Git Sync.
   */
  private async exchange(target: ProjectTarget): Promise<void> {
    if (this.closing || this.options.gitSync === undefined) {
      return;
    }
    const { location, database } = this.open(target);
    let due: boolean;
    try {
      due =
        hasProjectGit(dirname(location.configPath)) &&
        Date.now() >= synchronizationDueAt(database.getSynchronizationSchedule());
    } finally {
      database.close();
    }
    if (due) {
      await this.options.gitSync.request({ version: 1, action: "auto", options: target.options });
    }
  }

  /**
   * Удерживает проверенное соединение до завершения async операции, включая отказ.
   * SQLite callback-транзакция не охватывает Promise writer; snapshot выбирает конкретный reader.
   * activity после успешной операции сигналит о созревшем обмене, не ожидая его в HTTP.
   * local оставляет диагностику и SSE локальными. Данные ответа принадлежат локальному snapshot;
   * фоновый импорт не заменяет исходные guards формы и не повторяет пользовательскую запись.
   */
  async run<T>(
    projectId: string,
    action: (database: ProjectDatabase) => T | Promise<T>,
    mode: "activity" | "local" = "activity",
  ): Promise<T> {
    const target = this.target(projectId);
    const { location, database } = this.open(target);
    const operation = (async (): Promise<T> => {
      try {
        const due =
          mode === "activity" &&
          this.options.gitSync !== undefined &&
          hasProjectGit(dirname(location.configPath)) &&
          Date.now() >= synchronizationDueAt(database.getSynchronizationSchedule());
        const result = await action(database);
        if (due) {
          this.synchronization.request(projectId, () => this.exchange(target));
        }
        return result;
      } finally {
        database.close();
      }
    })();
    this.pending.add(operation);
    try {
      return await operation;
    } finally {
      this.pending.delete(operation);
    }
  }

  /**
   * Прекращает приём фоновой работы до HTTP drain, сохраняя завершение уже принятых writers.
   */
  stopSynchronization(): void {
    this.synchronization.stop();
  }

  /**
   * Завершает принятые HTTP-вызовы и фоновый обмен до освобождения ресурсов приложения.
   */
  async close(): Promise<void> {
    this.closing = true;
    this.stopSynchronization();
    await Promise.allSettled([...this.pending]);
    await this.synchronization.close();
  }
}
