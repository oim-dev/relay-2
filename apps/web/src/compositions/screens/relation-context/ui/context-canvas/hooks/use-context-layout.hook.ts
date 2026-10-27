import { useEffect, useRef, useState } from "react";
import ELK from "elkjs/lib/elk-api";
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url";
import type { RelationNode, RelationEdge } from "domains/relations";
import { createContextLayoutPlan } from "../helpers/create-context-layout-plan";
import { readContextLayout } from "../helpers/read-context-layout";
import type { ContextLayout, ContextNodeMove } from "../types/context-layout.type";
import type { ContextCanvasParams } from "../types/context-canvas-props.type";

/**
 * Пересчитывает узлы, порты и линии вместе; при расширении сохраняет позицию выбранного узла.
 */
export const useContextLayout = (
  nodes: RelationNode[],
  edges: RelationEdge[],
  root: string,
  selectedNodeId: string | null,
  view: ContextCanvasParams["view"],
  direction: ContextCanvasParams["direction"],
) => {
  const [layout, setLayout] = useState<ContextLayout>(() => ({
    nodes: new Map(),
    edges: new Map(),
    distances: new Map(),
    parents: new Map(),
  }));
  const layoutRef = useRef(layout);
  const anchorRef = useRef(root);
  const [isPending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    anchorRef.current = selectedNodeId ?? root;
  }, [selectedNodeId, root]);
  useEffect(() => {
    let isActive = true;
    const elk = new ELK({ workerFactory: () => new Worker(elkWorkerUrl) });
    const plan = createContextLayoutPlan(nodes, edges, root, view, direction);
    setPending(true);
    setError(null);
    void elk
      .layout(plan.graph)
      .then((result) => {
        if (!isActive) return;
        const anchorId = anchorRef.current;
        const previousAnchor = layoutRef.current.nodes.get(anchorId);
        const next = readContextLayout(
          result,
          plan,
          previousAnchor ? { id: anchorId, position: previousAnchor.position } : undefined,
        );
        layoutRef.current = next;
        setLayout(next);
      })
      .catch(() => {
        if (isActive)
          setError("Не удалось рассчитать расположение. Повторите раскладку или откройте список.");
      })
      .finally(() => {
        elk.terminateWorker();
        if (isActive) setPending(false);
      });
    return () => {
      isActive = false;
      elk.terminateWorker();
    };
  }, [nodes, edges, root, view, direction, attempt]);

  /**
   * Хранит ручной перенос отдельно от маршрутов автоматической раскладки.
   */
  const handleMove = (changes: ContextNodeMove[]): void => {
    const next = { ...layoutRef.current, nodes: new Map(layoutRef.current.nodes) };
    for (const change of changes) {
      const node = next.nodes.get(change.id);
      if (node) next.nodes.set(change.id, { ...node, position: change.position });
    }
    layoutRef.current = next;
    setLayout(next);
  };
  return {
    layout,
    isPending,
    error,
    onMove: handleMove,
    onRetry: () => setAttempt((value) => value + 1),
  };
};
