/**
 * Убирает отдельную Linux-группу fixture после assertions либо deadline.
 * Исчезнувшая группа допустима, остальные ошибки сигнализации сохраняются.
 */
export async function terminateLinuxGroup(pid: number): Promise<void> {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      throw error;
    }
  }
}
