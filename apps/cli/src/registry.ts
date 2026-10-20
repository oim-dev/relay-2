import { resolve } from "node:path";
import {
  KnowledgeService,
  TasksService,
  PlanningService,
  HistoryService,
  QueryService,
} from "@relay/core";
import { RelayError, type EntityRecord, type WriteOptions } from "@relay/contracts";
import { resolveProject, type ProjectLocation, type RuntimeOptions } from "@relay/project-runtime";
import { ProjectDatabase } from "@relay/storage";
import { define, type Args, type Command, type CommandContext } from "gunshi";
import { renderUsage } from "gunshi/renderer";
import { readInput, revisionArgs } from "./arguments";
import { CliUsageError } from "./errors";
import { renderResult, type Result } from "./output";
import { paginate } from "./pagination";
import type { CliRuntime } from "./runtime";

export const result = (data: unknown): Result => ({ data });
/** Повреждённое сохранённое поле не должно выглядеть как успешно прочитанный пустой список. */
export function records(value: unknown): Record<string, unknown>[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => !item || typeof item !== "object" || Array.isArray(item))
  ) {
    throw new RelayError("INVALID_DATA", "Повреждён формат вложенного списка записей", 1);
  }
  return value as Record<string, unknown>[];
}

export function references(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
    throw new RelayError("INVALID_DATA", "Повреждён формат сохранённых ссылок", 1);
  }
  return value as string[];
}
export function findItem(
  items: Record<string, unknown>[],
  id: string,
  label: string,
): Record<string, unknown> {
  if (items.some((item) => typeof item.id !== "string" || !item.id)) {
    throw new RelayError("INVALID_DATA", "У вложенной записи отсутствует ID", 1);
  }
  const item = items.find((item) => String(item.id) === id);
  if (!item) throw new RelayError("NOT_FOUND", `${label} «${id}» не найден`, 3);
  return item;
}

const shellQuote = (value: string): string =>
  /^[\w./:=+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
export async function renderHelp(ctx: Readonly<CommandContext>): Promise<string> {
  return `${ctx.description ?? ctx.env.description}\n\n${await renderUsage(ctx)}`;
}

export interface Action {
  description: string;
  args?: Args;
  fields?: Args;
  mode?: "create" | "update";
  local?: boolean;
  run: (invocation: Invocation) => Result;
}

export class Invocation {
  private database?: ProjectDatabase;
  private projectLocation?: ProjectLocation;
  readonly values: Record<string, unknown>;

  constructor(
    readonly context: Readonly<CommandContext>,
    readonly runtime: CliRuntime,
    readonly input: Record<string, unknown>,
  ) {
    this.values = context.values;
  }
  text(key: string): string {
    return String(this.values[key] ?? "");
  }
  get actor(): string {
    const actor = this.values.actor ?? this.runtime.env.RELAY_ACTOR;
    if (typeof actor !== "string" || !actor.trim())
      throw new CliUsageError("Для записи укажите --actor или RELAY_ACTOR", "ACTOR_REQUIRED");
    return actor;
  }
  get write(): WriteOptions {
    return { actor: this.actor, ifRevision: Number(this.values["if-revision"]) };
  }
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
  get location(): ProjectLocation {
    return (this.projectLocation ??= resolveProject(this.options));
  }
  get db(): ProjectDatabase {
    if (this.database) return this.database;
    const location = this.location;
    const database = ProjectDatabase.open(location.databasePath);
    if (database.projectId !== location.projectId) {
      database.close();
      throw new RelayError(
        "PROJECT_ID_MISMATCH",
        "База выбранного проекта была заменена между выбором и открытием",
        4,
        {
          databasePath: location.databasePath,
          expected: location.projectId,
          actual: database.projectId,
        },
      );
    }
    return (this.database = database);
  }
  get knowledge(): KnowledgeService {
    return new KnowledgeService(this.db);
  }
  get tasks(): TasksService {
    return new TasksService(this.db);
  }
  get planning(): PlanningService {
    return new PlanningService(this.db);
  }
  get history(): HistoryService {
    return new HistoryService(this.db);
  }
  get queries(): QueryService {
    return new QueryService(this.db);
  }
  close(): void {
    this.database?.close();
  }

  page<T>(
    items: readonly T[],
    extra: Record<string, unknown> = {},
    source?: { context: string; generation: string | number },
  ): Result {
    const entries = Object.entries(this.values)
      .filter(
        ([key, value]) =>
          value !== undefined &&
          !["config", "project", "actor", "format", "help", "version", "cursor", "limit"].includes(
            key,
          ),
      )
      .sort(([a], [b]) => a.localeCompare(b));
    const page = paginate(items, {
      context: source?.context ?? `${this.db.projectId}:${this.db.path}`,
      generation: source?.generation ?? this.db.getGeneration(),
      query: [this.context.commandPath, entries],
      limit: Number(this.values.limit ?? 20),
      explicitLimit: !!this.context.explicit.limit,
      ...(this.values.cursor ? { cursor: this.text("cursor") } : {}),
      command: (cursor, limit) => {
        const args = ["relay", ...this.context.commandPath];
        for (const [key, schema] of Object.entries(this.context.args)) {
          if (schema.type === "positional" && this.values[key] !== undefined)
            args.push(String(this.values[key]));
        }
        for (const [key, value] of entries) {
          if (this.context.args[key]?.type === "positional") continue;
          for (const item of Array.isArray(value) ? value : [value])
            args.push(`--${key}=${String(item)}`);
        }
        const options = this.options;
        // Продолжение адресует уже выбранную базу: проектный config не принимает селектор workspace.
        if (!source) args.push(`--config=${this.location.configPath}`);
        else if (options.config) args.push(`--config=${resolve(this.runtime.cwd, options.config)}`);
        if (source && options.project) args.push(`--project=${options.project}`);
        if (this.text("format") === "json") args.push("--format=json");
        args.push(`--limit=${limit}`, `--cursor=${cursor}`);
        return args.map(shellQuote).join(" ");
      },
    });
    return { data: { ...extra, items: page.items }, meta: { page: page.page } };
  }

  entities(items: EntityRecord[]): Result {
    const sort = this.text("sort") || "key";
    const ordered = [...items].sort((a, b) => {
      const left =
        sort === "updated"
          ? a.updatedAt
          : sort === "title"
            ? String(a.data.title ?? a.data.name ?? "")
            : a.key;
      const right =
        sort === "updated"
          ? b.updatedAt
          : sort === "title"
            ? String(b.data.title ?? b.data.name ?? "")
            : b.key;
      return (
        (left < right ? -1 : left > right ? 1 : 0) * (sort === "updated" ? -1 : 1) ||
        a.id.localeCompare(b.id)
      );
    });
    return this.page(ordered);
  }
}

export class CommandRegistry {
  readonly commands = new Map<string, Command>();
  constructor(private readonly runtime: CliRuntime) {}

  group(path: string, description: string): void {
    const command = this.node(path);
    command.description = description;
  }

  add(path: string, action: Action): void {
    const node = this.node(path);
    if (node.args) throw new Error(`Повторная регистрация: ${path}`);
    Object.assign(
      node,
      define({
        name: path.split(" ").at(-1)!,
        description: action.description,
        args: {
          ...action.args,
          ...action.fields,
          ...(action.mode === "update" ? revisionArgs : {}),
        },
        run: async (context) => {
          const input = await readInput(context.values, action.fields ?? {}, this.runtime);
          const invocation = new Invocation(context, this.runtime, input);
          try {
            if (action.mode) void invocation.actor;
            // Снимок связывает страницу с поколением, не резервируя блокировку писателя для чтения.
            const response = action.local
              ? action.run(invocation)
              : action.mode
                ? invocation.db.transaction(() => action.run(invocation))
                : invocation.db.snapshot(() => action.run(invocation));
            return renderResult(response, invocation.text("format") || "text");
          } finally {
            invocation.close();
          }
        },
      }),
    );
  }

  private node(path: string): Command {
    let commands = this.commands;
    let command: Command | undefined;
    for (const name of path.split(" ")) {
      command = commands.get(name);
      if (!command) {
        command = {
          name,
          description: name,
          run: renderHelp,
          subCommands: new Map<string, Command>(),
        };
        commands.set(name, command);
      }
      commands = command.subCommands as Map<string, Command>;
    }
    return command!;
  }
}

export function checkPositionals(ctx: Readonly<CommandContext>): void {
  if (ctx.validationError) return;
  const count = Object.values(ctx.args).filter((schema) => schema.type === "positional").length;
  const extra = ctx.positionals[ctx.commandPath.length + count] ?? ctx.rest[0];
  if (extra !== undefined) {
    throw new CliUsageError(
      count === 0 ? `Неизвестная команда: «${extra}»` : `Лишний аргумент: «${extra}»`,
    );
  }
}
