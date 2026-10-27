import { storageOrigin } from "./tab-storage";

/**
 * Отделяет настройки интерфейса текущего REST UI от старых persistence-ключей.
 */
function preferenceKey(key: string): string {
  return JSON.stringify(["relay-web-v2", storageOrigin(), key]);
}

/**
 * Читает недоверенные локальные данные, включая восстановление после повреждения JSON.
 */
export const readStored = (key: string): unknown => {
  try {
    const text = localStorage.getItem(preferenceKey(key));
    return text === null ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * Сохраняет снимок; сообщает отказ браузерного хранилища вызывающему владельцу.
 */
export const writeStored = (key: string, value: unknown): boolean => {
  try {
    localStorage.setItem(preferenceKey(key), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
};

/**
 * Удаляет подтверждённый либо явно отменённый черновик.
 */
export const removeStored = (key: string): void => {
  try {
    localStorage.removeItem(preferenceKey(key));
  } catch {
    // Недоступность persistence не препятствует работе с сервером.
  }
};

let sessionId: string | undefined;

/**
 * Идентифицирует текущую память вкладки; старая sessionStorage-сессия не восстанавливается.
 */
export const getBrowserSessionId = (): string => {
  if (sessionId === undefined) {
    sessionId = crypto.randomUUID();
  }
  return sessionId;
};
