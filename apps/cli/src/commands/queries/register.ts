import { QueryService } from "@relay/core";
import { validateEntityReadRequest } from "@relay/contracts";
import { choice, flag, pageArgs, positional, string } from "../../input/arguments";
import { CliUsageError } from "../../errors/errors";
import { queryCommandMessages as messages } from "../../locales/commands/queries";
import { result } from "../../output/output";
import type { Result } from "../../output/output.types";
import type { CommandRegistry } from "../../execution/registry";

/**
 * Добавляет адресное чтение, поиск и диагностику проекта в реестр без чтения базы.
 * get управляет снимком в Core; прочие чтения используют снимок инфраструктуры команд.
 */
export function registerQueryCommands(registry: CommandRegistry): void {
  registry.add("search", {
    ...messages.search,
    args: pageArgs,
    fields: {
      q: string(messages.query, true),
      kind: choice(messages.kind, [...QueryService.kinds]),
    },
    /**
     * Проверяет курсор до запуска Core; успешный запрос вычисляет полный состав перед выбором окна.
     */
    run: (i): Result => i.entities(() => i.queries.search(i.input)),
  });
  registry.add("get", {
    ...messages.get,
    args: {
      refs: { ...positional(messages.references, false), multiple: true },
      summary: flag(messages.summary),
    },
    presentation: "entity-read",
    execution: "service",
    /**
     * Объединяет адреса до и после -- и проверяет общий размер до открытия БД.
     * Core удерживает общий снимок и различает ошибки отдельных адресов.
     */
    run: (i): Result => {
      const positionals = i.values.refs ?? [];
      if (
        !Array.isArray(positionals) ||
        !positionals.every((ref): ref is string => typeof ref === "string")
      ) {
        throw new CliUsageError(messages.references);
      }
      const refs = [...positionals, ...i.context.rest];
      validateEntityReadRequest(refs);
      const data = i.queries.getMany(refs, {
        summary: i.values.summary === true,
      });
      const firstFailure = data.items.find((item) => !item.ok);
      return {
        data,
        ...(firstFailure && !firstFailure.ok
          ? { failure: { ...firstFailure.error, invalidInput: false } }
          : {}),
      };
    },
  });
  registry.add("overview", {
    ...messages.overview,
    args: pageArgs,
    presentation: "overview",
    /**
     * Возвращает сводку и страницу карты из одного снимка; карта читается целиком.
     */
    run: (i): Result => {
      const { items, ...overview } = i.queries.overview();
      return i.page(items, overview);
    },
  });
  registry.group("storage", messages.storage);
  registry.add("storage status", {
    ...messages.storageStatus,
    /**
     * Возвращает диагностические сведения о выбранном хранилище без изменения данных.
     */
    run: (i): Result => result(i.queries.status()),
  });
  registry.group("doctor", messages.doctor);
  registry.add("doctor check", {
    ...messages.doctorCheck,
    /**
     * Возвращает результаты предметных проверок Core, не исправляя сохранённые записи.
     */
    run: (i): Result => result(i.queries.check()),
  });
}
