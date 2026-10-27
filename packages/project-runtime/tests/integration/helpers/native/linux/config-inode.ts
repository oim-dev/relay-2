import { expect, spyOn } from "bun:test";
import * as fs from "node:fs";
import type { NonSharedBuffer } from "node:buffer";

/**
 * Воспроизводит окно Linux realpath Bun: inode заменён между open и чтением /proc/self/fd.
 * Настоящий rename сохраняет опубликованное имя; подмена касается только момента разрешения пути.
 * Проверяет срабатывание инъекции и восстанавливает fs/дескрипторы даже при отказе сценария.
 */
export function withReplacedConfigInode(path: string, operation: () => void): void {
  const realpath = fs.realpathSync;
  const originalNative = Object.getOwnPropertyDescriptor(realpath, "native");
  const expectedPath = Buffer.from(path);
  let replacements = 0;
  /**
   * Сохраняет кодировки realpath и воспроизводит смену inode только для проверяемого конфига.
   */
  const resolveDuringReplacement = (
    input: fs.PathLike,
    options?: fs.EncodingOption | fs.BufferEncodingOption,
  ): string | NonSharedBuffer => {
    const encoding = typeof options === "object" && options !== null ? options.encoding : options;
    let physical = realpath(input, "buffer");
    if (physical.equals(expectedPath)) {
      const descriptor = fs.openSync(path, "r");
      const temporary = `${path}.replacement`;
      try {
        fs.writeFileSync(temporary, fs.readFileSync(path));
        fs.renameSync(temporary, path);
        replacements++;
        physical = fs.readlinkSync(`/proc/self/fd/${descriptor}`, "buffer");
      } finally {
        fs.closeSync(descriptor);
        fs.rmSync(temporary, { force: true });
      }
    }
    return encoding === "buffer" ? physical : physical.toString(encoding ?? "utf8");
  };
  // Декоратор объединяет перегрузки fs; кодировка применяется после одной и той же инъекции.
  const resolver = spyOn(fs, "realpathSync").mockImplementation(
    Object.assign(resolveDuringReplacement, {
      native: resolveDuringReplacement,
    }) as typeof fs.realpathSync,
  );
  // mockImplementation переносит поведение вызова, но не свойства callback на сам spy.
  Object.defineProperty(resolver, "native", {
    value: resolveDuringReplacement,
    writable: true,
    configurable: true,
  });
  try {
    operation();
    expect(replacements).toBeGreaterThan(0);
  } finally {
    resolver.mockRestore();
    if (originalNative !== undefined) {
      Object.defineProperty(realpath, "native", originalNative);
    }
  }
}
