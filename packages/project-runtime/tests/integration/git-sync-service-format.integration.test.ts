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
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$xml=[xml][Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(config.content, "utf8").toString("base64")}'))
@{binary=$xml.Task.Actions.Exec.Command; arguments=$xml.Task.Actions.Exec.Arguments} | ConvertTo-Json -Compress
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
        const decoded: unknown = JSON.parse(result.stdout.replace(/^\uFEFF/u, ""));
        expect(decoded).toMatchObject({ binary, arguments: expect.any(String) });
        if (
          !decoded ||
          typeof decoded !== "object" ||
          !("arguments" in decoded) ||
          typeof decoded.arguments !== "string"
        ) {
          throw new Error("XML-декодер не вернул строку аргументов Windows");
        }
        expect(parseWindowsArguments(`unused.exe ${decoded.arguments}`)).toEqual([
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
