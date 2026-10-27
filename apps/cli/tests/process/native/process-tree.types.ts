/**
 * Независимая аварийная уборка дерева, запущенного CLI-fixture, без production guardian.
 */
export interface FixtureProcessTree {
  /* POSIX-группа создаётся при spawn; Windows taskkill работает с недетаченным деревом. */
  readonly detached: boolean;
  /**
   * Завершает только дерево собственного child; неизвестный системный отказ не поглощается.
   */
  terminate(pid: number): Promise<void>;
}
