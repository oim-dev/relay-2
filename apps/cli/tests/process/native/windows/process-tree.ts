/**
 * Убирает дерево своего Windows-child через taskkill, независимо от production cleanup.
 * Код 128 означает уже исчезнувший PID; прочие отказы не считаются успешной уборкой.
 */
export async function terminateWindowsTree(pid: number): Promise<void> {
  const killer = Bun.spawn(["taskkill.exe", "/PID", String(pid), "/T", "/F"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const code = await killer.exited;
  if (code !== 0 && code !== 128) {
    throw new Error(`taskkill завершился с кодом ${code}`);
  }
}
