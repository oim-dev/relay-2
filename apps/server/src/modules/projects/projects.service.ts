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
} from "@relay/project-runtime";
import { dirname } from "node:path";
import type { ProjectDatabase } from "@relay/storage";
import type { RelayServerOptions } from "../../server.types";
import { SERVER_OPTIONS } from "../../http/options";
import { httpMessages } from "../../http/http.messages";
import { publicError } from "../../http/errors";
import type { ProjectTarget } from "./project.types";

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
   * Удерживает проверенное соединение до завершения async операции, включая отказ.
   * SQLite callback-транзакция не охватывает Promise writer; snapshot выбирает конкретный reader.
   * activity ожидает созревший обмен перед Core; local оставляет диагностику и фоновые чтения локальными.
   * Ошибка доставки не препятствует предметной операции и не заменяет её исходные guards.
   */
  async run<T>(
    projectId: string,
    action: (database: ProjectDatabase) => T | Promise<T>,
    mode: "activity" | "local" = "activity",
  ): Promise<T> {
    const target = this.target(projectId);
    const { location, database } = openProject(target.options);
    const operation = (async (): Promise<T> => {
      try {
        if (
          location.projectId !== projectId ||
          physicalIdentity(location.databasePath) !== target.identity
        ) {
          throw new RelayError("PROJECT_CHANGED", httpMessages.projectChanged, 4);
        }
        if (
          mode === "activity" &&
          this.options.gitSync !== undefined &&
          hasProjectGit(dirname(location.configPath)) &&
          Date.now() >= synchronizationDueAt(database.getSynchronizationSchedule())
        ) {
          try {
            await this.options.gitSync.request({
              version: 1,
              action: "auto",
              options: target.options,
            });
          } catch (error) {
            // Ошибка доставки сохраняется транспортом; локальная предметная операция остаётся доступна.
            await this.options.synchronizationWarning?.(publicError(error));
          }
        }
        return await action(database);
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
   * Завершает принятые вызовы до освобождения последнего соединения.
   */
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.pending]);
  }
}
