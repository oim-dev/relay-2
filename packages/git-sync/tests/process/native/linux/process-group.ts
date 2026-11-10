/**
 * Аварийно завершает собственную detached-группу fixture; ошибка сигнала остаётся видна тесту.
 */
export function killLinuxFixtureGroup(pid: number): void {
  process.kill(-pid, "SIGKILL");
}
