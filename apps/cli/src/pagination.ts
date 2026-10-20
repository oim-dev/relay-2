import { createHash } from "node:crypto";
import { RelayError } from "@relay/contracts";
import { CliUsageError } from "./errors";

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

interface Cursor {
  version: 1;
  context: string;
  query: string;
  generation: number | string;
  offset: number;
  limit: number;
}

export interface Page {
  count: number;
  total: number;
  limit: number;
  nextCursor: string | null;
  nextCommand: string | null;
  consistency: "snapshot";
}

const encode = (cursor: Cursor): string => {
  const json = JSON.stringify(cursor);
  return `${Buffer.from(json).toString("base64url")}.${fingerprint(json).slice(0, 16)}`;
};
function decode(text: string): Cursor {
  try {
    const [body, checksum, extra] = text.split(".");
    const json = Buffer.from(body ?? "", "base64url").toString("utf8");
    if (extra || checksum !== fingerprint(json).slice(0, 16)) throw new Error();
    const cursor = JSON.parse(json) as Cursor;
    if (
      cursor.version !== 1 ||
      !Number.isSafeInteger(cursor.offset) ||
      cursor.offset < 1 ||
      !Number.isSafeInteger(cursor.limit) ||
      cursor.limit < 1 ||
      cursor.limit > 100
    )
      throw new Error();
    return cursor;
  } catch {
    throw new CliUsageError("Повреждённый курсор страницы", "INVALID_CURSOR");
  }
}

export function paginate<T>(
  items: readonly T[],
  options: {
    context: string;
    query: unknown;
    generation: number | string;
    limit: number;
    explicitLimit: boolean;
    cursor?: string;
    command: (cursor: string, limit: number) => string;
  },
): { items: T[]; page: Page } {
  const query = fingerprint(options.query);
  const previous = options.cursor ? decode(options.cursor) : undefined;
  if (
    previous &&
    (previous.context !== options.context ||
      previous.query !== query ||
      (options.explicitLimit && previous.limit !== options.limit))
  ) {
    throw new CliUsageError("Курсор относится к другому проекту или запросу", "INVALID_CURSOR");
  }
  if (previous && previous.generation !== options.generation) {
    throw new RelayError(
      "SNAPSHOT_CONFLICT",
      "Данные изменились. Начните список заново без --cursor",
      4,
    );
  }
  const offset = previous?.offset ?? 0;
  const limit = previous?.limit ?? options.limit;
  const selected = items.slice(offset, offset + limit);
  const nextCursor =
    offset + limit < items.length
      ? encode({
          version: 1,
          context: options.context,
          query,
          generation: options.generation,
          offset: offset + limit,
          limit,
        })
      : null;
  return {
    items: selected,
    page: {
      count: selected.length,
      total: items.length,
      limit,
      nextCursor,
      nextCommand: nextCursor ? options.command(nextCursor, limit) : null,
      consistency: "snapshot",
    },
  };
}
