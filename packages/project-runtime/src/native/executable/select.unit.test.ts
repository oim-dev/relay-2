import { describe, expect, test } from "bun:test";
import { nativeExecutableName } from "./select";
import { linuxExecutable } from "./linux";
import { macosExecutable } from "./macos";
import { windowsExecutable } from "./windows";

const executableNames = [
  { name: "Linux", platform: "linux", expected: "relay Ω" },
  { name: "macOS", platform: "darwin", expected: "relay Ω" },
  { name: "Windows", platform: "win32", expected: "relay Ω.exe" },
] as const;
const searchPaths = [
  {
    name: "Linux сохраняет пробелы и игнорирует Path",
    adapter: linuxExecutable,
    environment: { PATH: ":/opt/Relay Ω/bin::/usr/bin:", Path: "/wrong" },
    expected: ["/opt/Relay Ω/bin", "/usr/bin"],
  },
  {
    name: "macOS сохраняет пробелы и игнорирует Path",
    adapter: macosExecutable,
    environment: { PATH: ":/Applications/Relay Ω/bin::/usr/bin:", Path: "/wrong" },
    expected: ["/Applications/Relay Ω/bin", "/usr/bin"],
  },
  {
    name: "Windows сохраняет drive colon и выбирает первый регистронезависимый PATH",
    adapter: windowsExecutable,
    environment: { pAtH: ";C:\\Relay Ω\\bin;;D:\\Git\\cmd;", PATH: "C:\\wrong" },
    expected: ["C:\\Relay Ω\\bin", "D:\\Git\\cmd"],
  },
] as const;

describe("Платформенное обнаружение executable", () => {
  test.each(executableNames)(
    "$name: имя поставки сохраняет Unicode и native-суффикс",
    ({ platform, expected }) => {
      const name = nativeExecutableName("relay Ω", platform);

      expect(name).toBe(expected);
    },
  );

  test.each(searchPaths)("$name", ({ adapter, environment, expected }) => {
    const paths = adapter.searchPath(environment);

    expect(paths).toEqual(expected);
  });
});
