import type { NativeCommands } from "../native-command";

/**
 * Передаёт Unicode PowerShell как UTF-16, не вызывая профиль или интерактивный ввод.
 * Запуск и журнал принадлежат commands; malformed JSON остаётся отказом наблюдения.
 */
export async function runPowerShell(commands: NativeCommands, source: string): Promise<unknown> {
  const preamble =
    "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); ";
  const result = await commands.run("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(preamble + source, "utf16le").toString("base64"),
  ]);
  return JSON.parse(result.stdout.replace(/^\uFEFF/u, ""));
}

/**
 * Кодирует одну строковую константу внутри PowerShell EncodedCommand.
 */
export function psString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
