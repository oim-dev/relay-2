import { resolve } from "node:path";
import type { RuntimeOptions } from "@relay/project-runtime";
import type { CommandContext } from "gunshi";
import type { ArgumentValues, InputFields } from "../input/arguments.types";
import { CliUsageError } from "../errors/errors";
import { registryMessages } from "../locales/registry";
import type { CliRuntime } from "./runtime.types";

/**
 * Локальный/процессный вызов без API проектной БД, снимка и предметных сервисов.
 * Асинхронный сценарий получает только аргументы, ввод и явно переданную среду.
 */
export class LocalInvocation {
  /* Уже разобранные параметры текущего Gunshi-вызова. */
  readonly values: ArgumentValues;
  /* Изолированный контекст парсера. */
  readonly context: Readonly<CommandContext>;
  /* Явные окружение, потоки и процессный порт. */
  readonly runtime: CliRuntime;
  /* Поля после разрешения единственного источника ввода. */
  readonly input: InputFields;

  /**
   * Сохраняет вход без выбора проекта и файловых операций.
   */
  constructor(context: Readonly<CommandContext>, runtime: CliRuntime, input: InputFields) {
    this.context = context;
    this.runtime = runtime;
    this.input = input;
    this.values = context.values;
  }

  /**
   * Возвращает дословную строку параметра; отсутствие представляется пустой строкой.
   */
  text(key: string): string {
    return String(this.values[key] ?? "");
  }

  /**
   * Выбирает автора с приоритетом --actor над RELAY_ACTOR, сохраняя значимые пробелы.
   */
  get actor(): string {
    const actor = this.values.actor ?? this.runtime.env.RELAY_ACTOR;
    if (typeof actor !== "string" || !actor.trim()) {
      throw new CliUsageError(registryMessages.actorRequired, "ACTOR_REQUIRED");
    }
    return actor;
  }

  /**
   * Формирует локальный контекст без открытия БД; явные параметры имеют приоритет над env.
   */
  get options(): RuntimeOptions {
    const config = this.values.config ?? this.runtime.env.RELAY_CONFIG;
    const userHome = this.runtime.env.HOME ?? this.runtime.env.USERPROFILE;
    const home =
      this.runtime.env.RELAY_HOME ?? (userHome ? resolve(userHome, ".relay") : undefined);
    return {
      cwd: this.runtime.cwd,
      ...(home !== undefined ? { home } : {}),
      ...(config !== undefined ? { config: String(config) } : {}),
      ...(this.values.project !== undefined ? { project: this.text("project") } : {}),
    };
  }
}
