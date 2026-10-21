import { QueryService } from "@relay/core";
import { choice, pageArgs, refArgs, string } from "../../input/arguments";
import { queryCommandMessages as messages } from "../../locales/commands/queries";
import { result } from "../../output/output";
import type { Result } from "../../output/output.types";
import type { CommandRegistry } from "../../execution/registry";

/**
 * Добавляет поиск, инспекцию и диагностику проекта в реестр без чтения базы.
 * Согласованный снимок каждого вызова принадлежит инфраструктуре команд.
 */
export function registerQueryCommands(registry: CommandRegistry): void {
  registry.add("search", {
    description: messages.search,
    args: pageArgs,
    fields: {
      q: string(messages.query, true),
      kind: choice(messages.kind, [...QueryService.kinds]),
    },
    /**
     * Возвращает страницу поиска Core; полный набор совпадений загружается до пагинации.
     */
    run: (i): Result => i.entities(i.queries.search(i.input)),
  });
  registry.group("inspect", messages.inspect);
  for (const command of ["get", "resolve"]) {
    registry.add(`inspect ${command}`, {
      description: messages.inspectGet,
      args: refArgs,
      /**
       * Возвращает полную запись, найденную Core по пользовательской ссылке.
       */
      run: (i): Result => result(i.queries.get(i.text("ref"))),
    });
  }
  registry.add("overview", {
    description: messages.overview,
    args: pageArgs,
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
    description: messages.storageStatus,
    /**
     * Возвращает диагностические сведения о выбранном хранилище без изменения данных.
     */
    run: (i): Result => result(i.queries.status()),
  });
  registry.group("doctor", messages.doctor);
  registry.add("doctor check", {
    description: messages.doctorCheck,
    /**
     * Возвращает результаты предметных проверок Core, не исправляя сохранённые записи.
     */
    run: (i): Result => result(i.queries.check()),
  });
}
