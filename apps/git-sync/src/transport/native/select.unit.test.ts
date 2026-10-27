import { describe, expect, test } from "bun:test";
import { nativeGitPlatform } from "./select";

const remoteCases = [
  {
    name: "Linux: scp с однобуквенным host остаётся SSH",
    platform: "linux",
    remote: "c:repo",
    expected: true,
  },
  {
    name: "macOS: scp с однобуквенным host остаётся SSH",
    platform: "darwin",
    remote: "c:repo",
    expected: true,
  },
  {
    name: "Windows: drive-relative путь не становится SSH",
    platform: "win32",
    remote: "C:repo",
    expected: false,
  },
  {
    name: "Windows: drive-absolute путь не становится SSH",
    platform: "win32",
    remote: "C:\\repo",
    expected: false,
  },
  {
    name: "Windows: UNC путь не становится SSH",
    platform: "win32",
    remote: "\\\\host\\repo",
    expected: false,
  },
  {
    name: "Windows: scp с пользователем остаётся SSH",
    platform: "win32",
    remote: "git@host:repo",
    expected: true,
  },
  {
    name: "Windows: SSH URL с портом остаётся SSH",
    platform: "win32",
    remote: "ssh://git@host:2222/repo",
    expected: true,
  },
  {
    name: "Linux: HTTPS URL не становится scp",
    platform: "linux",
    remote: "https://host/repo",
    expected: false,
  },
  {
    name: "macOS: относительный файл с двоеточием не становится scp",
    platform: "darwin",
    remote: "./host:repo",
    expected: false,
  },
] as const;
const shellCases = [
  {
    name: "Linux сохраняет backslash",
    platform: "linux",
    expected: "'C:\\Relay Ω\\O'\\''Connor\\ssh.exe'",
  },
  {
    name: "macOS сохраняет backslash",
    platform: "darwin",
    expected: "'C:\\Relay Ω\\O'\\''Connor\\ssh.exe'",
  },
  {
    name: "Git for Windows передаёт slash своему sh",
    platform: "win32",
    expected: "'C:/Relay Ω/O'\\''Connor/ssh.exe'",
  },
] as const;

describe("Выбор native Git/SSH синтаксиса", () => {
  test.each(remoteCases)("$name", ({ platform, remote, expected }) => {
    const usesSsh = nativeGitPlatform(platform).usesSsh(remote);

    expect(usesSsh).toBe(expected);
  });

  test.each(shellCases)(
    "$name: пробел, Unicode и апостроф остаются одним argv",
    ({ platform, expected }) => {
      const word = nativeGitPlatform(platform).shellWord("C:\\Relay Ω\\O'Connor\\ssh.exe");

      expect(word).toBe(expected);
    },
  );
});
