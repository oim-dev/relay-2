import { runNativeProcess, type ProcessResult } from "@relay/project-runtime";

/**
 * Разбирает Task XML настоящим PowerShell XML-parser без регистрации службы.
 * ASCII-envelope сохраняет Unicode независимо от OEM-кодировки; caller проверяет exit и оба поля.
 * Окружение/каталог изолированы caller, процесс и потоки ограничены штатным runner deadline.
 */
export async function readWindowsServiceXml(
  content: string,
  cwd: string,
  home: string,
): Promise<ProcessResult> {
  const source = `
$ErrorActionPreference='Stop'
[Console]::Error.WriteLine('RELAY_SERVICE_FORMAT: entered')
$xml=[xml][Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(content, "utf8").toString("base64")}'))
[Console]::Error.WriteLine('RELAY_SERVICE_FORMAT: xml-parsed')
[Console]::WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$xml.Task.Actions.Exec.Command)))
[Console]::WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$xml.Task.Actions.Exec.Arguments)))
[Console]::Error.WriteLine('RELAY_SERVICE_FORMAT: completed')
`;
  return runNativeProcess({
    executable: "powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(source, "utf16le").toString("base64"),
    ],
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    timeoutMs: 30_000,
  });
}
