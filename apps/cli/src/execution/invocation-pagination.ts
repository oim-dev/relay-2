import { resolve } from "node:path";
import type { EntityRecord } from "@relay/contracts";
import type { InvocationPageContext, PageQueryEntries } from "./invocation.types";
import type { Result } from "../output/output.types";
import { paginate } from "../pagination/pagination";
import { DEFAULT_PAGE_SIZE } from "../pagination/pagination.constants";
import type { LocalPageSource, PageSource } from "../pagination/pagination.types";

const NON_QUERY_OPTIONS = new Set([
  "config",
  "project",
  "actor",
  "format",
  "help",
  "version",
  "cursor",
  "limit",
]);

/**
 * Экранирует один аргумент для повторного запуска в POSIX shell, включая одиночные кавычки.
 */
function shellQuote(value: string): string {
  return /^[\w./:=+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Выделяет и сортирует параметры, определяющие состав списка, для стабильного отпечатка запроса.
 */
function queryEntries(invocation: InvocationPageContext): PageQueryEntries {
  return Object.entries(invocation.values)
    .filter(([key, value]) => value !== undefined && !NON_QUERY_OPTIONS.has(key))
    .sort(([left], [right]) => left.localeCompare(right));
}

/**
 * Восстанавливает пользовательские позиционные и повторяемые параметры в порядке исходной схемы.
 */
function queryArguments(invocation: InvocationPageContext, entries: PageQueryEntries): string[] {
  const args = ["relay", ...invocation.context.commandPath];
  for (const [key, schema] of Object.entries(invocation.context.args)) {
    if (schema.type === "positional" && invocation.values[key] !== undefined) {
      args.push(String(invocation.values[key]));
    }
  }
  for (const [key, value] of entries) {
    if (invocation.context.args[key]?.type === "positional") {
      continue;
    }
    for (const item of Array.isArray(value) ? value : [value]) {
      args.push(`--${key}=${String(item)}`);
    }
  }
  return args;
}

/**
 * Строит воспроизводимое продолжение с тем же проектом, фильтрами, форматом и размером окна.
 * Проектная страница закрепляет уже выбранную базу через её config; локальная сохраняет workspace.
 */
function continuationCommand(
  invocation: InvocationPageContext,
  entries: PageQueryEntries,
  source: LocalPageSource | undefined,
  cursor: string,
  limit: number,
): string {
  const args = queryArguments(invocation, entries);
  const options = invocation.options;
  if (!source) {
    // Проектный config уже адресует выбранную базу и не принимает селектор workspace.
    args.push(`--config=${invocation.location.configPath}`);
  } else if (options.config) {
    args.push(`--config=${resolve(options.cwd, options.config)}`);
  }
  if (source && options.project) {
    args.push(`--project=${options.project}`);
  }
  if (invocation.values.format === "json") {
    args.push("--format=json");
  }
  args.push(`--limit=${limit}`, `--cursor=${cursor}`);
  return args.map(shellQuote).join(" ");
}

/**
 * Привязывает страницу к текущему вызову и оформляет метаданные ответа.
 * Вызывающий реестр удерживает snapshot; локальный источник передаёт собственные context/generation
 * и не открывает БД. Источник-функция вызывается только после проверки курсора.
 * Его owner дополняет data и имеет приоритет над extra; items всегда принадлежит окну.
 */
export function invocationPage<T>(
  invocation: InvocationPageContext,
  items: PageSource<T>,
  extra: Readonly<Record<string, unknown>> = {},
  source?: LocalPageSource,
): Result {
  const entries = queryEntries(invocation);
  const page = paginate(items, {
    context: source?.context ?? `${invocation.db.projectId}:${invocation.db.path}`,
    generation: source?.generation ?? invocation.db.getGeneration(),
    query: [invocation.context.commandPath, entries],
    limit: Number(invocation.values.limit ?? DEFAULT_PAGE_SIZE),
    explicitLimit: !!invocation.context.explicit.limit,
    ...(invocation.values.cursor ? { cursor: String(invocation.values.cursor) } : {}),
    /**
     * Восстанавливает команду только для существующего следующего окна.
     */
    command: (cursor: string, limit: number): string =>
      continuationCommand(invocation, entries, source, cursor, limit),
  });
  return { data: { ...extra, ...page.owner, items: page.items }, meta: { page: page.page } };
}

/**
 * Выбирает ключ отображаемого порядка, не вмешиваясь в предметную фильтрацию Core.
 */
function entitySortValue(entity: EntityRecord, sort: string): string {
  if (sort === "updated") {
    return entity.updatedAt;
  }
  if (sort === "title") {
    return String(entity.data.title ?? entity.data.name ?? "");
  }
  return entity.key;
}

/**
 * Сравнивает два ключа в прежнем лексикографическом порядке JavaScript без локализации.
 */
function compareSortValues(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/**
 * Сортирует копию уже вычисленного состава; ID разрешает равенство основных ключей.
 * updated идёт по убыванию, остальные порядки — по возрастанию; стоимость зависит от всего состава.
 */
export function orderEntities(items: readonly EntityRecord[], sort: string): EntityRecord[] {
  const direction = sort === "updated" ? -1 : 1;
  return [...items].sort(
    (left, right) =>
      compareSortValues(entitySortValue(left, sort), entitySortValue(right, sort)) * direction ||
      left.id.localeCompare(right.id),
  );
}
