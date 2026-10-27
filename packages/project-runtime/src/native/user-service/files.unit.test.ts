import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { selectUserService } from "./select";

const formats = [
  { platform: "linux", bytes: [0xd0, 0xa0, 0xd0, 0xb5, 0xd0, 0xbb, 0xd0, 0xb5, 0xd0, 0xb9] },
  { platform: "darwin", bytes: [0xd0, 0xa0, 0xd0, 0xb5, 0xd0, 0xbb, 0xd0, 0xb5, 0xd0, 0xb9] },
  {
    platform: "win32",
    bytes: [0xff, 0xfe, 0x20, 0x04, 0x35, 0x04, 0x3b, 0x04, 0x35, 0x04, 0x39, 0x04],
  },
] as const;

/**
 * Создаёт отдельный каталог под артефактами; вызывающий удаляет его в finally.
 */
function serviceFileDirectory(): string {
  const root = join(
    import.meta.dir,
    "../../../../../.artifacts",
    new Date().toISOString().slice(0, 10),
    "native-adapters",
    "service-files",
  );
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, "case-"));
}

/**
 * Поддержанная таблица не должна переходить к неизвестной реализации.
 */
function unsupportedPlatform(): Error {
  return new Error("Не выбрана тестовая платформа службы");
}

describe("Кодировка файлов выбранного native manager", () => {
  test.each(formats)(
    "$platform: публикация сохраняет Unicode и точные BOM/байты",
    ({ platform, bytes }) => {
      const directory = serviceFileDirectory();
      const path = join(directory, "service.conf");
      const files = selectUserService(platform, unsupportedPlatform).files;
      try {
        expect(files.read(path)).toBeUndefined();

        files.write(path, "старое содержимое");
        files.write(path, "Релей");

        expect([...readFileSync(path)]).toEqual([...bytes]);
        expect(files.read(path)).toBe("Релей");
        expect(readdirSync(directory)).toEqual(["service.conf"]);
        files.remove(path);
        expect(readdirSync(directory)).toEqual([]);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  test("неподдержанная ОС не получает Linux/POSIX fallback", () => {
    const failure = new Error("Публичный отказ приложения");

    expect(() => selectUserService("freebsd", () => failure)).toThrow(failure);
  });
});
