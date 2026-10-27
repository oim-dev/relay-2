import { describe, expect, test } from "bun:test";
import type { KnowledgeRecord } from "@relay/contracts";
import { entityRouteLocation, entityRouteTarget } from "./entity-route-path";

describe("Совместимые адреса Relay", () => {
  test("явный материал заменяет обе прежние формы выбора, сохраняя остальные параметры", () => {
    const target = entityRouteLocation(
      "/projects/id",
      "work-history?point=new&session=owner",
      "?point=old&checkpoint=older&q=text",
      "#context",
    );

    expect(target).toBe("/projects/id/work-history?point=new&q=text&session=owner#context");
  });

  test("адрес сценария использует ID владельца и сущности, а не читаемый ключ", () => {
    const entity: KnowledgeRecord<"scenario"> = {
      id: "scenario-id",
      key: "SCENARIO/old",
      kind: "scenario",
      revision: 1,
      createdAt: "2026-10-26T00:00:00Z",
      updatedAt: "2026-10-26T00:00:00Z",
      createdBy: "Автор",
      updatedBy: "Автор",
      data: { featureId: "feature-id", name: "Сценарий", summary: "", description: "" },
    };

    expect(entityRouteTarget(entity)).toBe("product/features/feature-id/scenarios/scenario-id");
  });
});
