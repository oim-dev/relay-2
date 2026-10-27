/**
 * Идентифицирует контекст сервера текущего origin.
 */
export const getProjectKey = (projectId: string): readonly ["project/context", string] => [
  "project/context",
  projectId,
];
