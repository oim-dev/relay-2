import { QueryService } from "@relay/core";
import { choice, pageArgs, refArgs, string } from "../arguments";
import { type CommandRegistry, result } from "../registry";

export function registerQueryCommands(registry: CommandRegistry): void {
  registry.add("search", {
    description: "Поиск по ID, ключу и предметным текстам; прежние ключи разрешаются точно",
    args: pageArgs,
    fields: {
      q: string("Текст запроса", true),
      kind: choice("Тип сущности", [...QueryService.kinds]),
    },
    run: (i) => i.entities(i.queries.search(i.input)),
  });
  registry.group("inspect", "Инспекция сохранённых сущностей");
  for (const command of ["get", "resolve"])
    registry.add(`inspect ${command}`, {
      description: "Полная запись по ID, ключу, алиасу или ссылке kind:ID / kind:key",
      args: refArgs,
      run: (i) => result(i.queries.get(i.text("ref"))),
    });
  registry.add("overview", {
    description: "Сводка проекта и страница карты сущностей",
    args: pageArgs,
    run: (i) => {
      const { items, ...overview } = i.queries.overview();
      return i.page(items, overview);
    },
  });
  registry.group("storage", "Локальное SQLite-хранилище");
  registry.add("storage status", {
    description: "Путь, размер файла SQLite, поколение и число сохранённых записей",
    run: (i) => result(i.queries.status()),
  });
  registry.group("doctor", "Проверки локального проекта");
  registry.add("doctor check", {
    description: "Проверить базовые записи, метаданные, ссылки и граф обязательств задач",
    run: (i) => result(i.queries.check()),
  });
}
