import { z } from "zod";

/** Метаданные уровня принадлежат конфигурации маршрута, а не разбору pathname. */
export const ROUTE_BREADCRUMB_SCHEMA = z.object({
  label: z.string().describe("Название уровня или вида записи до загрузки"),
  path: z.string().optional().describe("Шаблон пути относительно корня проекта"),
  source: z
    .object({
      kind: z
        .enum([
          "feature",
          "scenario",
          "application",
          "implementation",
          "document",
          "board",
          "task",
          "work-plan",
          "release",
        ])
        .describe("Вид адресно читаемой записи"),
      param: z.string().describe("Имя параметра маршрута с ключом, ID или slug"),
    })
    .optional()
    .describe("Источник динамической подписи"),
  preserveBoardFilters: z.boolean().optional().describe("Сохранить фильтры при возврате на доску"),
});

/** Контракт handle React Router; неизвестные служебные handles пропускаются. */
export const BREADCRUMB_HANDLE_SCHEMA = z.object({
  breadcrumbs: z.array(ROUTE_BREADCRUMB_SCHEMA).describe("Уровни, добавляемые совпавшим маршрутом"),
});

/** Один уровень, объявленный владельцем URL. */
export type RouteBreadcrumb = z.infer<typeof ROUTE_BREADCRUMB_SCHEMA>;
/** Типизированные метаданные маршрута для навигации глубины. */
export type BreadcrumbRouteHandle = z.infer<typeof BREADCRUMB_HANDLE_SCHEMA>;
