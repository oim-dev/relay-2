import { useEffect } from "react";
import { useUpdateNodeInternals } from "@xyflow/react";
import type { ContextPortsSyncProps } from "./types/context-ports-sync-props.type";

/**
 * Обновляет геометрию всех изменённых портов одним действием React Flow.
 *
 * Используется для:
 *  - раскрытия графа без каскада отдельных обновлений каждого узла
 */
export const ContextPortsSync = ({ signature }: ContextPortsSyncProps) => {
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    const nodeIds = signature
      .split("|")
      .filter(Boolean)
      .map((entry) => entry.split(";")[0] ?? "");
    updateNodeInternals(nodeIds);
  }, [signature, updateNodeInternals]);
  return null;
};
