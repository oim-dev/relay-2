/**
 * Передаёт URL Windows Shell через explorer.exe без cmd.exe.
 */
export function windowsBrowserCommand(url: string): readonly [string, string] {
  return ["explorer.exe", url];
}
