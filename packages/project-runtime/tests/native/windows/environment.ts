import { realpathSync } from "node:fs";
import { userInfo } from "node:os";
import type { NativeCommands } from "../native-command";
import type { NativeSession } from "../native-service.types";
import { runPowerShell } from "./powershell";

/**
 * Проверяет Task Scheduler текущей интерактивной сессии без изменения login/elevation/пароля.
 */
export async function preflightWindowsSession(commands: NativeCommands): Promise<NativeSession> {
  const userHome = realpathSync(userInfo().homedir);
  const identity = await runPowerShell(
    commands,
    `
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$session=(Get-Process -Id $PID).SessionId
$interactive=@($identity.Groups | ForEach-Object { $_.Value }) -contains 'S-1-5-4'
if ($session -eq 0 -or -not $interactive) {
  throw 'NATIVE_SERVICE_SESSION_REQUIRED: нужен runner текущего пользователя в уже открытой интерактивной Windows-сессии; service Session 0 не подходит'
}
$scheduler=New-Object -ComObject Schedule.Service
$scheduler.Connect()
@{ userName=$identity.Name; sessionId=$session; scheduler=$scheduler.Connected } | ConvertTo-Json -Compress
`,
  );
  if (
    !identity ||
    typeof identity !== "object" ||
    !("userName" in identity) ||
    typeof identity.userName !== "string" ||
    !identity.userName.trim() ||
    !("scheduler" in identity) ||
    identity.scheduler !== true
  ) {
    throw new Error("NATIVE_SERVICE_SESSION_REQUIRED: нет текущего пользователя Task Scheduler");
  }
  return { userHome, userName: identity.userName, uid: null, linger: null };
}
