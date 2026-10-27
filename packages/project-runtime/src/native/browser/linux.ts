/**
 * Передаёт URL обработчику desktop-сессии Linux.
 */
export function linuxBrowserCommand(url: string): readonly [string, string] {
  return ["xdg-open", url];
}
