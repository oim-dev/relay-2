/**
 * Убирает собственную foreground-группу macOS без обещания захватить escaped setsid-потомков.
 * Исчезнувшая группа допустима, остальные ошибки сигнализации сохраняются.
 */
export async function terminateMacosGroup(pid: number): Promise<void> {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      throw error;
    }
  }
}
