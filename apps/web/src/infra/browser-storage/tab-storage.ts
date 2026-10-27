import type { SessionReadResult, TabStorage } from "./storage.types";

/**
 * Возвращает origin браузера; при SSR отдельный экземпляр памяти не восстанавливает drafts.
 */
export function storageOrigin(): string {
  return typeof location === "undefined" ? "" : location.origin;
}

/**
 * Хранит drafts только до закрытия/перезагрузки вкладки. Persistence легаси намеренно
 * не импортируется: там нет надёжной связи с frozen request текущего транспорта.
 * Ключи вызывающих форм содержат projectId, этот слой добавляет origin и копирует ввод.
 */
export function createTabStorage(getOrigin: () => string = storageOrigin): TabStorage {
  const values = new Map<string, string>();

  /**
   * Разделяет одинаковые ключи формы между origin без коллизии разделителей.
   */
  function scopedKey(key: string): string {
    return JSON.stringify([getOrigin(), key]);
  }

  /**
   * Возвращает новую копию JSON; исходный guard не меняется при редактировании результата.
   */
  function read(key: string): SessionReadResult {
    const raw = values.get(scopedKey(key));
    return { value: raw === undefined ? undefined : JSON.parse(raw), error: null };
  }

  /**
   * Сериализует до замены прежнего снимка: отказ не уничтожает существующий draft.
   */
  function write(key: string, value: unknown): boolean {
    try {
      const raw = JSON.stringify(value);
      if (raw === undefined) {
        return false;
      }
      values.set(scopedKey(key), raw);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Удаляет подтверждённый или явно отменённый draft только в текущем origin.
   */
  function remove(key: string): void {
    values.delete(scopedKey(key));
  }

  return { read, write, remove };
}
