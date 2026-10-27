/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { RelationNeighborhood } from "@relay/contracts";
import { relationView } from "./relation-view";

describe("Представление Core-соседства", () => {
  test("отзыв документа использует ревизию владельца без фиктивных author/createdAt ребра", () => {
    const page: RelationNeighborhood = {
      root: { kind: "document", id: "document" },
      nodes: [],
      endpoints: [],
      paths: [],
      totalNodes: 2,
      totalEdges: 1,
      nextOffset: null,
      boundary: [],
      depthLimited: false,
      generation: 7,
      edges: [
        {
          id: "edge",
          type: "documents",
          from: { kind: "document", id: "document" },
          to: { kind: "feature", id: "feature" },
          description: "Назначение",
          revision: 3,
        },
      ],
    };
    const original = structuredClone(page);

    const view = relationView(page);

    expect(view.version).toBe("7");
    expect(view.edges[0]?.remove).toEqual({
      op: "document.unlink",
      ref: "document",
      ifRevision: 3,
      input: { target: "feature", type: "documents" },
    });
    expect(view.edges[0]).not.toHaveProperty("createdAt");
    expect(view.edges[0]).not.toHaveProperty("createdBy");
    expect(page).toEqual(original);
  });
});
