/**
 * Команда передачи проверенного URL браузеру пользователя без shell.
 * Launcher имеет отдельный deadline; браузер не включается в контейнер Relay.
 */
export type BrowserCommand = (url: string) => readonly [string, string];
