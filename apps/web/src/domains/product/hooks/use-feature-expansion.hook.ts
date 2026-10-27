import { useState } from "react";
import { z } from "zod";
import { readStored, writeStored } from "infra/browser-storage";

const EXPANSION_SCHEMA = z.record(z.string(), z.boolean());

/** Личное состояние дерева выбранного проекта; ID и раскрытие не зависят от URL. */
export const useFeatureExpansion = (projectId: string) => {
  const storageKey = `relay:project:${projectId}:feature-expansion`;
  const [states, setStates] = useState<Record<string, Record<string, boolean>>>({});
  const [canPersist, setCanPersist] = useState(true);
  const parsed = EXPANSION_SCHEMA.safeParse(readStored(storageKey));
  const expanded = states[projectId] ?? (parsed.success ? parsed.data : {});
  const setExpanded = (value: Record<string, boolean>) => {
    setStates((previous) => ({ ...previous, [projectId]: value }));
    setCanPersist(writeStored(storageKey, value));
  };
  return { expanded, setExpanded, canPersist };
};
