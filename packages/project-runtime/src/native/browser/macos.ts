/**
 * Передаёт URL Launch Services macOS отдельным аргументом open.
 */
export function macosBrowserCommand(url: string): readonly [string, string] {
  return ["open", url];
}
