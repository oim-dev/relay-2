import { describe, expect, test } from "bun:test";
import { createServiceConfiguration, runNativeProcess } from "@relay/project-runtime";
import { RuntimeFixture } from "./helpers/runtime-fixture";
import { parseWindowsArguments } from "./helpers/windows-arguments";

const group = "git-sync-implementation/cli-runtime";

describe("Нативное чтение формата Windows service", () => {
  // shell32 доступен только Windows; Linux/macOS не выдаются за нативную проверку CommandLineToArgvW.
  test.skipIf(process.platform !== "win32")(
    "Task XML и Arguments возвращают точные Unicode argv через Windows API",
    async () => {
      const fixture = new RuntimeFixture(group);
      const home = 'C:\\Users\\Ира\\данные "quoted"\\';
      const binary = "C:\\Program Files\\Relay & team\\relay-git-sync.exe";
      const config = createServiceConfiguration({
        platform: "win32",
        binary,
        home,
        userHome: fixture.root,
        userName: "TEAM\\Ира",
      });
      const source = `
$ErrorActionPreference='Stop'
[Console]::Error.WriteLine('RELAY_SERVICE_FORMAT: entered')
$xml=[xml][Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(config.content, "utf8").toString("base64")}'))
[Console]::Error.WriteLine('RELAY_SERVICE_FORMAT: xml-parsed')
[Console]::WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$xml.Task.Actions.Exec.Command)))
[Console]::WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$xml.Task.Actions.Exec.Arguments)))
[Console]::Error.WriteLine('RELAY_SERVICE_FORMAT: completed')
`;
      try {
        const result = await runNativeProcess({
          executable: "powershell.exe",
          args: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(source, "utf16le").toString("base64"),
          ],
          cwd: fixture.cwd,
          env: { ...process.env, HOME: fixture.root, USERPROFILE: fixture.root },
          timeoutMs: 30_000,
        });

        expect(result.exitCode).toBe(0);
        // ASCII-envelope не зависит от OEM-кодировки и не меняет Console.OutputEncoding.
        const encoded = result.stdout
          .replace(/^\uFEFF/u, "")
          .trim()
          .split(/\r?\n/u);
        expect(encoded).toHaveLength(2);
        const [decodedBinary, decodedArguments] = encoded.map((value) =>
          Buffer.from(value, "base64").toString("utf8"),
        );
        expect(decodedBinary).toBe(binary);
        if (decodedArguments === undefined) {
          throw new Error("XML-декодер не вернул строку аргументов Windows");
        }
        expect(parseWindowsArguments(`unused.exe ${decodedArguments}`)).toEqual([
          "unused.exe",
          "supervise",
          "--home",
          home,
        ]);
      } finally {
        await fixture.dispose();
      }
    },
    40_000,
  );
});
