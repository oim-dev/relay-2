import { describe, expect, spyOn, test } from "bun:test";
import { BatchService } from "../../src/batch/batch";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { withEntityDatabase } from "./helpers/entity-fixture";

const changes = [
  { name: "замена одной реализации", changed: true },
  { name: "no-op состава", changed: false },
] as const;
const retainedDescription = "НЕ-ПЕРЕЧИТЫВАТЬ-ТЕКСТ-НЕИЗМЕНЁННОЙ-РЕАЛИЗАЦИИ";

describe("Стоимость сравнения участия в batch", () => {
  test.each(changes)("$name не добавляет полных чтений неизменённой истории", ({ changed }) => {
    withEntityDatabase((db) => {
      const knowledge = new KnowledgeService(db);
      const retainedTarget = knowledge.create("feature", { name: "Сохранить" }, "author");
      const previousTarget = knowledge.create("feature", { name: "Прежняя цель" }, "author");
      const nextTarget = changed
        ? knowledge.create("feature", { name: "Новая цель" }, "author")
        : previousTarget;
      const application = knowledge.create("application", { name: "Web", slug: "web" }, "author");
      const retained = knowledge.create(
        "implementation",
        {
          application: application.id,
          target: retainedTarget.id,
          title: "Прежнее участие",
          description: retainedDescription,
        },
        "author",
      );
      const previous = knowledge.create(
        "implementation",
        {
          application: application.id,
          target: previousTarget.id,
          title: "Заменяемое участие",
        },
        "author",
      );
      const current = knowledge.get("application", application.id);
      const generation = db.getGeneration();
      const history = spyOn(db, "listByField");
      const finalRead = spyOn(db, "getMany");
      const parse = spyOn(JSON, "parse");
      try {
        const result = new BatchService(db).execute(
          {
            version: 1,
            operations: [
              {
                op: "application.participation.replace",
                ref: current.id,
                ifRevision: current.revision,
                input: { targets: [retainedTarget.id, nextTarget.id] },
              },
            ],
          },
          { actor: "agent", operationKey: "participation-cost" },
        );

        // Полную историю читает владелец правил один раз; неизменённая карточка
        // не должна декодироваться для before/after или попадать в итоговое окно пакета.
        expect(history.mock.calls).toEqual([["implementation", "applicationId", application.id]]);
        expect(
          parse.mock.calls.filter(([text]) => text.includes(retainedDescription)),
        ).toHaveLength(1);
        expect(finalRead).toHaveBeenCalledTimes(1);
        expect(finalRead.mock.calls[0]?.[0]).not.toContain(retained.id);
        expect(result.entities).toHaveLength(changed ? 3 : 1);
        expect(result.items[0]?.owner).toMatchObject({
          id: current.id,
          revision: current.revision + Number(changed),
        });
        if (changed) {
          const created = result.entities.find(
            (entity) => entity.kind === "implementation" && entity.data.targetId === nextTarget.id,
          );
          if (created === undefined) {
            throw new Error("В итоговом наборе отсутствует созданная реализация");
          }
          expect(created).toMatchObject({
            revision: 1,
            data: { applicationId: current.id, active: true },
          });
          expect(result.entities.find((entity) => entity.id === previous.id)).toMatchObject({
            revision: previous.revision + 1,
            data: { active: false },
          });
          expect(result.entities.find((entity) => entity.id === current.id)).toMatchObject({
            data: { implementationIds: [retained.id, created.id].sort() },
          });
          expect(new Set(finalRead.mock.calls[0]?.[0])).toEqual(
            new Set([current.id, previous.id, created.id]),
          );
          expect(result.items[0]?.outputs).toHaveLength(2);
        } else {
          expect(result.entities).toEqual([current]);
          expect(result.items[0]?.outputs).toEqual([]);
          expect(finalRead.mock.calls[0]?.[0]).toEqual([current.id]);
          expect(db.getGeneration()).toBe(generation);
        }
      } finally {
        parse.mockRestore();
        finalRead.mockRestore();
        history.mockRestore();
      }
    });
  });
});
