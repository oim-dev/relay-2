import { describe, expect, test } from "bun:test";
import type { KnowledgeRecord } from "@relay/contracts";
import { toEntitySummary } from "./entity-summary";

const feature: KnowledgeRecord<"feature"> = {
  id: "feature",
  kind: "feature",
  key: "FEATURE-1",
  revision: 1,
  createdAt: "2026-10-26T00:00:00Z",
  updatedAt: "2026-10-26T00:00:00Z",
  createdBy: "Автор",
  updatedBy: "Автор",
  data: { name: "Фича", summary: "Кратко", description: "Описание" },
};

describe("Карточка цели библиотеки", () => {
  test("фича доступна выбору без вымышленного статуса готовности", () => {
    const summary = toEntitySummary(feature);

    expect(summary).toEqual({
      ref: { kind: "feature", id: "feature" },
      key: "FEATURE-1",
      title: "Фича",
      summary: "Кратко",
      revision: 1,
      active: true,
    });
  });

  test("снятая реализация сохраняет done независимо от доступности выбора", () => {
    const implementation: KnowledgeRecord<"implementation"> = {
      ...feature,
      id: "implementation",
      kind: "implementation",
      key: "WEB-FI-1",
      data: {
        title: "Вклад",
        description: "Описание",
        status: "done",
        active: false,
        applicationId: "app",
        featureId: "feature",
        targetKind: "feature",
        targetId: "feature",
      },
    };

    const summary = toEntitySummary(implementation);

    expect(summary.active).toBe(false);
    expect(summary.status).toBe("done");
  });
});
