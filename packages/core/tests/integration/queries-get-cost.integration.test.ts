import { describe, expect, spyOn, test } from "bun:test";
import { ProjectDatabase } from "@relay/storage";
import type { EntitySummary, KnowledgeRecord, ProjectEntity } from "@relay/contracts";
import * as documentSections from "../../src/knowledge/document-sections";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { QueryService } from "../../src/queries/queries";
import { TasksService } from "../../src/tasks/tasks";
import { entityWriteOptions as write, withEntityDatabase } from "./helpers/entity-fixture";

const views = [
  { name: "полное", summary: false },
  { name: "краткое", summary: true },
] as const;

describe("Ограниченная стоимость группового чтения", () => {
  test("200 адресов читают уникальные выбранные карточки одним пакетом и строят один индекс разделов", () => {
    withEntityDatabase((db) => {
      const knowledge = new KnowledgeService(db);
      const first = knowledge.create(
        "document",
        { name: "Первый", body: "Первый текст" },
        "tester",
      );
      const second = knowledge.create(
        "document",
        { name: "Второй", body: "Второй текст" },
        "tester",
      );
      const renamed = knowledge.rename("document", second.id, "SECOND", write(second));
      const unrelated = knowledge.create(
        "document",
        { name: "Посторонний", body: "НЕЗАПРОШЕННОЕ-СОДЕРЖАНИЕ" },
        "tester",
      );
      // Полное чтение проекта провалилось бы на повреждении невыбранного документа.
      db.update({ ...unrelated, revision: 2, data: { ...unrelated.data, relations: null } }, 1);
      const refs = Array.from({ length: 200 }, (_, index) =>
        index % 2 === 0 ? first.id : second.key,
      );
      const lists = spyOn(db, "list");
      const single = spyOn(db, "get");
      const identities = spyOn(db, "getIdentity");
      const addresses = spyOn(db, "resolveMany");
      const batch = spyOn(db, "getMany");
      const sections = spyOn(documentSections, "indexDocumentSections");
      try {
        const result = new QueryService(db).getMany(refs);

        expect(result.items).toEqual(
          refs.map((ref, index) => ({ ref, ok: true, entity: index % 2 === 0 ? first : renamed })),
        );
        expect(addresses).toHaveBeenCalledTimes(1);
        expect(identities).not.toHaveBeenCalled();
        expect(batch).toHaveBeenCalledTimes(1);
        expect(batch.mock.calls[0]?.[0]).toEqual([first.id, second.id, db.projectId]);
        expect(single).not.toHaveBeenCalled();
        expect(lists).not.toHaveBeenCalled();
        expect(sections).toHaveBeenCalledTimes(1);
      } finally {
        lists.mockRestore();
        single.mockRestore();
        identities.mockRestore();
        addresses.mockRestore();
        batch.mockRestore();
        sections.mockRestore();
      }
    });
  });

  test("summary не читает полные карточки, тела, критерии, комментарии и паспорт проекта", () => {
    withEntityDatabase((db) => {
      const knowledge = new KnowledgeService(db);
      const document = knowledge.create(
        "document",
        { name: "Правила", body: "НЕ-ЧИТАТЬ-ТЕЛО", summary: "НЕ-ЧИТАТЬ-АННОТАЦИЮ" },
        "tester",
      );
      const tasks = new TasksService(db);
      const task = tasks.create(
        {
          title: "Задача",
          description: "НЕ-ЧИТАТЬ-ОПИСАНИЕ",
          acceptanceCriteria: [{ title: "Критерий", description: "НЕ-ЧИТАТЬ-КРИТЕРИЙ" }],
        },
        "tester",
      );
      tasks.comment(task.id, "НЕ-ЧИТАТЬ-КОММЕНТАРИЙ", "tester");
      const generation = db.getGeneration();
      const lists = spyOn(db, "list");
      const single = spyOn(db, "get");
      const full = spyOn(db, "getMany");
      const summary = spyOn(db, "getManySummaries");
      const parsed: string[] = [];
      const parse = JSON.parse;
      const parsing = spyOn(JSON, "parse").mockImplementation((value, reviver) => {
        parsed.push(value);
        return parse(value, reviver);
      });
      try {
        const result = new QueryService(db).getMany([document.key, task.id, task.key], {
          summary: true,
        });

        expect(result).toEqual({
          view: "summary",
          generation,
          items: [
            {
              ref: document.key,
              ok: true,
              entity: {
                id: document.id,
                kind: "document",
                key: document.key,
                revision: 1,
                title: "Правила",
                state: "draft",
              },
            },
            ...[task.id, task.key].map((ref) => ({
              ref,
              ok: true as const,
              entity: {
                id: task.id,
                kind: "task" as const,
                key: task.key,
                revision: 1,
                title: "Задача",
                state: "inbox" as const,
              },
            })),
          ],
        });
        expect(summary).toHaveBeenCalledTimes(1);
        expect(summary.mock.calls[0]?.[0]).toEqual([document.id, task.id]);
        expect(lists).not.toHaveBeenCalled();
        expect(single).not.toHaveBeenCalled();
        expect(full).not.toHaveBeenCalled();
        expect(parsed.some((value) => value.includes("НЕ-ЧИТАТЬ"))).toBe(false);
      } finally {
        lists.mockRestore();
        single.mockRestore();
        full.mockRestore();
        summary.mockRestore();
        parsing.mockRestore();
      }
    });
  });
});

describe("Единый снимок группового чтения", () => {
  test.each(views)(
    "$name чтение удерживает адреса, каталог, ревизии и поколение при конкурентном commit",
    ({ summary }) => {
      withEntityDatabase((db) => {
        const knowledge = new KnowledgeService(db);
        const project = knowledge.changeSection(
          "create",
          { id: "guides", name: "Руководства" },
          write(knowledge.get("project")),
        );
        const document = knowledge.create(
          "document",
          { name: "Прежнее имя", body: "Прежний текст", sectionId: "guides" },
          "tester",
        );
        const generation = db.getGeneration();
        const queries = new QueryService(db);
        const writer = ProjectDatabase.open(db.path);
        let updated: KnowledgeRecord<"document"> | undefined;
        /**
         * Сохраняет настоящее пакетное разрешение перед точным барьером конкурентного commit.
         */
        const original: ProjectDatabase["resolveMany"] = db.resolveMany.bind(db);
        const addresses = spyOn(db, "resolveMany").mockImplementationOnce((refs) => {
          const identities = original(refs);
          writer.transaction(() => {
            const writing = new KnowledgeService(writer);
            writing.changeSection("remove", { id: "guides" }, write(project));
            const changed = writing.update(
              "document",
              document.id,
              { name: "Новое имя", body: "Новый текст" },
              write(document),
            );
            updated = writing.rename("document", changed.id, "RENAMED", write(changed));
          });
          return identities;
        });
        try {
          const result = queries.getMany([document.key, document.id], { summary });

          const entity: EntitySummary | ProjectEntity = summary
            ? {
                id: document.id,
                kind: "document",
                key: document.key,
                revision: document.revision,
                title: "Прежнее имя",
                state: "draft",
              }
            : document;
          expect(result.view).toBe(summary ? "summary" : "full");
          expect(result.generation).toBe(generation);
          expect(result.items.map((item) => item.ref)).toEqual([document.key, document.id]);
          expect(result.items.map((item) => (item.ok ? item.entity : item.error))).toEqual([
            entity,
            entity,
          ]);
        } finally {
          addresses.mockRestore();
          writer.close();
        }
        if (!updated) {
          throw new Error("Конкурентный писатель не обновил документ");
        }

        const next = queries.getMany([document.key], { summary });

        expect(next.generation).toBe(db.getGeneration());
        expect(next.generation).toBeGreaterThan(generation);
        const nextEntity: EntitySummary | ProjectEntity = summary
          ? {
              id: document.id,
              kind: "document",
              key: "RENAMED",
              revision: updated.revision,
              title: "Новое имя",
              state: "draft",
            }
          : { ...updated, data: { ...updated.data, sectionId: null } };
        expect(next.items.map((item) => item.ref)).toEqual([document.key]);
        expect(next.items.map((item) => (item.ok ? item.entity : item.error))).toEqual([
          nextEntity,
        ]);
      });
    },
  );
});
