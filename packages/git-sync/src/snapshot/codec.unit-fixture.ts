import type { PortableComponent, PortableEntity, PortableProjectSnapshot } from "@relay/contracts";
import type { GitFiles } from "../transport/repository.types";
import { object, parseJson } from "./json";

/**
 * Создаёт независимую логическую проекцию для физического codec без SQLite и Git.
 * Версии намеренно фиксированы: проверка их предметного содержания принадлежит Core.
 */
export function createCodecSnapshot(
  body = "\ufeff# Начало\r\n\tТекст  \r\n",
): PortableProjectSnapshot {
  const entities: PortableEntity[] = [
    codecEntity("board", "board", { name: "Доска", slug: "product", prefix: "PRODUCT" }),
    codecEntity("document", "document", {
      name: "Документ",
      summary: "unpaired:\ud800",
      body,
      documentKind: "description",
      documentStatus: "draft",
      sectionId: null,
      pinned: false,
    }),
    codecEntity("project", "project", { name: "Проект", slug: "project" }),
    codecEntity("task", "task", {
      boardId: "board",
      title: "Задача",
      description: "",
      column: "inbox",
      parentId: null,
    }),
  ];
  return {
    formatVersion: 1,
    modelVersion: 2,
    projectId: "project",
    entities,
    components: [
      ...entities.map(({ record }): PortableComponent<"address-assignment"> => ({
        ownerId: record.id,
        kind: "address-assignment",
        id: `address-${record.id}`,
        position: "V",
        version: "c".repeat(64),
        parents: [],
        deleted: false,
        value: { ref: record.key },
      })),
      {
        ownerId: "task",
        kind: "task-criterion",
        id: "criterion",
        position: "V",
        version: "b".repeat(64),
        parents: [],
        deleted: false,
        value: {
          id: "criterion",
          title: "Критерий",
          summary: body,
          description: body,
          completed: false,
          completedAt: null,
          completedBy: null,
        },
      },
    ],
    addresses: entities.map(({ record }) => ({ ref: record.id, entityId: record.id })),
    comments: [
      {
        taskId: "task",
        after: null,
        comment: {
          id: "comment",
          title: "",
          body,
          createdAt: "2026-01-01T00:00:00.000Z",
          createdBy: "Автор",
        },
      },
    ],
    receipts: [],
    confirmations: [],
    publication: null,
  };
}

/**
 * Собирает только первичные поля владельца без локальной ревизии и агрегированных коллекций.
 */
function codecEntity(
  id: string,
  kind: PortableEntity["record"]["kind"],
  data: PortableEntity["record"]["data"],
): PortableEntity {
  return {
    version: "a".repeat(64),
    parents: [],
    record: {
      id,
      kind,
      key: id,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      createdBy: "Автор",
      updatedBy: "Автор",
      data,
    },
  };
}

/**
 * Читает единственную строку выбранной таблицы; отсутствие или несколько строк — ошибка fixture.
 */
export function readCodecRow(files: GitFiles, table: string): [string, Record<string, unknown>] {
  const entries = [...files].filter(([path]) => path.startsWith(`${table}/`));
  if (entries.length !== 1 || !entries[0]) {
    throw new Error(`В fixture ожидалась единственная строка ${table}`);
  }
  const [path, bytes] = entries[0];
  return [path, object(parseJson(bytes))];
}
