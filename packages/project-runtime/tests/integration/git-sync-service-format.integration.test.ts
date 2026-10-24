import { describe, expect, test } from "bun:test";
import { createServiceConfiguration, runNativeProcess } from "@relay/project-runtime";
import { RuntimeFixture } from "./helpers/runtime-fixture";

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
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RelayArgumentFixture {
  [DllImport("shell32.dll", SetLastError=true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string command, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  public static string[] Parse(string command) {
    int count; IntPtr memory=CommandLineToArgvW(command, out count);
    if(memory==IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
    try { string[] args=new string[count]; for(int i=0;i<count;i++) args[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory,i*IntPtr.Size)); return args; }
    finally { LocalFree(memory); }
  }
}
'@
[Console]::Error.WriteLine('RELAY_SERVICE_FORMAT: native-parser-compiled')
$xml=[xml][Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(config.content, "utf8").toString("base64")}'))
@{binary=$xml.Task.Actions.Exec.Command; args=[RelayArgumentFixture]::Parse('unused.exe '+$xml.Task.Actions.Exec.Arguments)} | ConvertTo-Json -Compress
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
        expect(JSON.parse(result.stdout.replace(/^\uFEFF/u, ""))).toEqual({
          binary,
          args: ["unused.exe", "supervise", "--home", home],
        });
      } finally {
        await fixture.dispose();
      }
    },
    40_000,
  );
});
