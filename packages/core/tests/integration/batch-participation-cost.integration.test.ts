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
  test.each(changes)(
    "$name не добавляет полных чтений неизменённой истории",
    async ({ changed }) => {
      await withEntityDatabase(async (db) => {
        const knowledge = new KnowledgeService(db);
        const retainedTarget = await knowledge.create("feature", { name: "Сохранить" }, "author");
        const previousTarget = await knowledge.create(
          "feature",
          { name: "Прежняя цель" },
          "author",
        );
        const nextTarget = changed
          ? await knowledge.create("feature", { name: "Новая цель" }, "author")
          : previousTarget;
        const application = await knowledge.create(
          "application",
          { name: "Web", slug: "web" },
          "author",
        );
        const retained = await knowledge.create(
          "implementation",
          {
            application: application.id,
            target: retainedTarget.id,
            title: "Прежнее участие",
            description: retainedDescription,
          },
          "author",
        );
        const previous = await knowledge.create(
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
        const history = spyOn(db.commands, "load");
        const finalRead = spyOn(db, "getMany");
        const commit = spyOn(db.commands, "commit");
        try {
          const result = await new BatchService(db).execute(
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

          // Полная история загружается один раз. Итог собирается из overlay; запись
          // read-context в публикацию не является дополнительным предметным чтением.
          const selectors = history.mock.calls.flatMap(([request]) => request.selectors);
          expect(selectors.filter((selector) => selector.kind === "field")).toEqual([
            {
              kind: "field",
              entityKind: "implementation",
              field: "applicationId",
              value: application.id,
            },
          ]);
          expect(
            selectors.some((selector) => selector.kind === "kind" || selector.kind === "records"),
          ).toBe(false);
          expect(
            selectors
              .filter((selector) => selector.kind === "entity")
              .map((selector) => selector.ref),
          ).not.toContain(retained.id);
          expect(finalRead).not.toHaveBeenCalled();
          expect(commit).toHaveBeenCalledTimes(1);
          const effects =
            commit.mock.calls[0]?.[0].transitions.flatMap((transition) => transition.effects) ?? [];
          expect(
            effects.some((effect) => effect.kind === "entity" && effect.after.id === retained.id),
          ).toBe(false);
          expect(result.entities.map((record) => record.id)).not.toContain(retained.id);
          expect(result.entities).toHaveLength(changed ? 3 : 1);
          expect(result.items[0]?.owner).toMatchObject({
            id: current.id,
            revision: current.revision + Number(changed),
          });
          if (changed) {
            const created = result.entities.find(
              (entity) =>
                entity.kind === "implementation" && entity.data.targetId === nextTarget.id,
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
            expect(new Set(result.entities.map((record) => record.id))).toEqual(
              new Set([current.id, previous.id, created.id]),
            );
            expect(result.items[0]?.outputs).toHaveLength(2);
          } else {
            expect(result.entities).toEqual([current]);
            expect(result.items[0]?.outputs).toEqual([]);
            expect(effects).toEqual([]);
            expect(db.getGeneration()).toBe(generation);
          }
        } finally {
          commit.mockRestore();
          finalRead.mockRestore();
          history.mockRestore();
        }
      });
    },
  );
});
