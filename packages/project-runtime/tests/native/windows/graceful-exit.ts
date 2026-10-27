import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import type { NativeCommands } from "../native-command";
import { psString, runPowerShell } from "./powershell";

/**
 * Удерживает handle конкретного Windows supervisor до graceful-завершения публичным Runtime API.
 * Ready-файл синхронизирует открытие handle до stop; Kernel ExitCode=0 проверяется до recovery.
 * Наблюдатель не меняет task, не запускает S и не передаёт capability в argv/журналы.
 */
export async function withWindowsGracefulExit(
  commands: NativeCommands,
  binary: string,
  pid: number,
  stop: () => Promise<void>,
): Promise<void> {
  const ready = join(commands.directory, `exit-${randomUUID()}.ready`);
  let finished = false;
  const completion = runPowerShell(
    commands,
    `
$process=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'
if ($null -eq $process -or $process.ExecutablePath -ne ${psString(binary)}) { throw 'Чужой или исчезнувший PID' }
$owner=Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
if ($owner.Sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'Чужой пользователь процесса' }
$watched=[Diagnostics.Process]::GetProcessById(${pid})
try {
  $null=$watched.Handle
  if ($watched.MainModule.FileName -ne ${psString(binary)}) { throw 'Исполняемый файл PID изменился' }
  $marker=[IO.File]::Open(${psString(ready)}, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  $marker.Dispose()
  if (-not $watched.WaitForExit(20000)) { throw 'Supervisor не завершил graceful shutdown' }
  @{ kind='graceful-exit'; pid=${pid}; exitCode=$watched.ExitCode;
     exitCodeHex=('0x{0:X8}' -f $watched.ExitCode); exitedAt=[DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
} finally { $watched.Dispose() }
`,
  ).then(
    (value) => {
      finished = true;
      return { ok: true as const, value };
    },
    (error: unknown) => {
      finished = true;
      return { ok: false as const, error };
    },
  );
  try {
    const deadline = performance.now() + 10_000;
    while (!existsSync(ready)) {
      if (finished) {
        const outcome = await completion;
        throw outcome.ok ? new Error("Наблюдатель завершился до ready-барьера") : outcome.error;
      }
      if (performance.now() >= deadline) {
        throw new Error("Не получен ready-барьер наблюдателя process handle");
      }
      await pause(25);
    }
    await stop();
    const outcome = await completion;
    if (!outcome.ok) {
      throw outcome.error;
    }
    expect(outcome.value).toMatchObject({
      kind: "graceful-exit",
      pid,
      exitCode: 0,
      exitCodeHex: "0x00000000",
    });
  } finally {
    // Команда имеет свой 30s deadline; её handle/guardian освобождаются и при отказе stop.
    await completion;
    rmSync(ready, { force: true });
  }
}
