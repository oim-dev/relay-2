import { describe, expect, test } from "bun:test";
import { parseNativePlatform } from "./platform";

const platforms = [
  { name: "Linux", input: "linux", expected: "linux" },
  { name: "macOS", input: "darwin", expected: "darwin" },
  { name: "Windows", input: "win32", expected: "win32" },
  { name: "неподдерживаемая POSIX ОС", input: "freebsd", expected: undefined },
  { name: "похожее имя Windows", input: "windows", expected: undefined },
  { name: "имя с пробелом", input: "linux ", expected: undefined },
  { name: "пустое имя", input: "", expected: undefined },
] as const;

describe("Граница поддерживаемых native-платформ", () => {
  test.each(platforms)("$name: имя не получает неявный POSIX fallback", ({ input, expected }) => {
    const platform = parseNativePlatform(input);

    expect(platform).toBe(expected);
  });
});
