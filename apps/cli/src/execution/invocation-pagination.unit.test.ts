import { describe, expect, test } from "bun:test";
import { createCommandContext } from "gunshi/context";
import { invocationPage } from "./invocation-pagination";
import type { InvocationPageContext } from "./invocation.types";

const writePreconditions = [
  { flag: "expected-version", value: "opaque-source-token" },
  { flag: "target-version", value: "opaque-target-token" },
  { flag: "if-revision", value: 3 },
  { flag: "target-revision", value: 7 },
] as const;

describe("Чтение страниц без write-only предусловий", () => {
  test.each(writePreconditions)(
    "$flag не меняет fingerprint и отсутствует в nextCommand",
    async ({ flag, value }) => {
      const context = await createCommandContext({
        command: { name: "list", args: { q: { type: "string" } } },
      });
      const invocation: InvocationPageContext = {
        context,
        values: { limit: 1, q: "same-filter", [flag]: value },
        options: { cwd: "/fixture" },
        /**
         * Локальная страница не должна открывать проект ради обработки metadata.
         */
        get location(): never {
          throw new Error("Не нужен проект");
        },
        /**
         * Источник задаёт своё поколение; проектная БД не используется.
         */
        get db(): never {
          throw new Error("Не нужна БД");
        },
      };
      const source = { context: "local-fixture", generation: 1 };

      const first = invocationPage(invocation, ["first", "second"], {}, source);
      const cursor = first.meta?.page?.nextCursor;
      if (typeof cursor !== "string") {
        throw new Error("Нет ожидаемого продолжения");
      }
      const continuation: InvocationPageContext = {
        context,
        values: { q: "same-filter", cursor },
        options: invocation.options,
        /**
         * Сохраняет ленивую границу проекта и при продолжении.
         */
        get location(): InvocationPageContext["location"] {
          return invocation.location;
        },
        /**
         * Продолжение локальной страницы также не должно обращаться к БД.
         */
        get db(): InvocationPageContext["db"] {
          return invocation.db;
        },
      };
      const last = invocationPage(continuation, ["first", "second"], {}, source);

      expect(first.data).toEqual({ items: ["first"] });
      expect(first.meta?.page?.nextCommand).not.toContain(`--${flag}`);
      expect(last.data).toEqual({ items: ["second"] });
      expect(last.meta?.page).toMatchObject({ total: 2, count: 1, limit: 1, nextCursor: null });
    },
  );
});
