/**
 * Аварийно завершает собственную foreground-группу без обещания удержать escaped macOS-потомков.
 */
export function killMacosFixtureGroup(pid: number): void {
  process.kill(-pid, "SIGKILL");
}
