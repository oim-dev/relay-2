/**
 * Предметные действия над связями; транспортные имена команд выбирает доменный адаптер.
 */
export const TASK_RELATION_ACTIONS = [
  "parent.set",
  "parent.clear",
  "dependency.add",
  "dependency.remove",
  "related.add",
  "related.remove",
  "target.add",
  "target.remove",
] as const;
