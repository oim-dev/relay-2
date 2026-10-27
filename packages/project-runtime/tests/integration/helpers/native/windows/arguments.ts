import { dlopen, FFIType, ptr, read, toArrayBuffer } from "bun:ffi";

/**
 * Читает UTF-16 аргумент из принадлежащего CommandLineToArgvW блока до его LocalFree.
 * Размер ограничен длиной исходной командной строки; незавершённый native результат отвергается.
 */
function readWindowsArgument(address: number, maximumLength: number): string {
  for (let length = 0; length <= maximumLength; length += 1) {
    if (read.u16(address, length * 2) === 0) {
      if (length === 0) {
        return "";
      }
      return Buffer.from(toArrayBuffer(address, 0, length * 2)).toString("utf16le");
    }
  }
  throw new Error("Windows вернул аргумент без завершающего UTF-16 NUL");
}

/**
 * Разбирает командную строку настоящим shell32 API без компиляции вспомогательного C#.
 * Вызывается только в Windows-тесте на поддерживаемом Bun Win64 ABI; native память и DLL
 * освобождаются до возврата. Это независимый от production quoting декодер, не его копия.
 */
export function parseWindowsArguments(command: string): string[] {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch)) {
    throw new Error("Нативный декодер аргументов требует Windows с 64-битным Bun");
  }
  const kernel = dlopen("kernel32.dll", {
    LocalFree: { args: [FFIType.ptr], returns: FFIType.ptr },
    GetLastError: { args: [], returns: FFIType.u32 },
  });
  try {
    const shell = dlopen("shell32.dll", {
      CommandLineToArgvW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    });
    try {
      const input = Buffer.from(`${command}\0`, "utf16le");
      const count = new Int32Array(1);
      const memory = shell.symbols.CommandLineToArgvW(ptr(input), ptr(count));
      if (!memory) {
        throw new Error(`CommandLineToArgvW отказал: ${kernel.symbols.GetLastError()}`);
      }
      try {
        const size = count[0];
        if (size === undefined || size < 1 || size > command.length + 1) {
          throw new Error("Windows вернул недопустимое число аргументов");
        }
        const args: string[] = [];
        for (let index = 0; index < size; index += 1) {
          // Win64 использует восемь байт на указатель и на x64, и на arm64.
          const address = read.ptr(memory, index * 8);
          if (!address) {
            throw new Error("Windows вернул пустой указатель аргумента");
          }
          args.push(readWindowsArgument(address, command.length));
        }
        return args;
      } finally {
        kernel.symbols.LocalFree(memory);
      }
    } finally {
      shell.close();
    }
  } finally {
    kernel.close();
  }
}
