import { expect } from "bun:test";
import type { NativeCommands } from "../native-command";
import type { NativeConfiguration } from "../native-service.types";
import { psString, runPowerShell } from "./powershell";

// Отказ fixture в диапазоне прикладных exit codes, а не служебный -1 от Process.Kill/Stop-Process.
const CRASH_EXIT_CODE = 86;

// Читает именно зарегистрированную задачу; ENOENT определяется HRESULT, а не языком Windows.
const scheduler = `
$scheduler=New-Object -ComObject Schedule.Service
$scheduler.Connect()
$folder=$scheduler.GetFolder('\\')
$task=$null
try { $task=$folder.GetTask($name) } catch {
  $failure=$_.Exception
  while ($failure.InnerException) { $failure=$failure.InnerException }
  if ($failure.HResult -ne -2147024894) { throw }
}
`;

// Проверяет реальные argv процесса через штатный parser Windows, включая executable с пробелами.
const argumentParser = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NativeServiceArgv {
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
function Sid([string] $name) {
  if ($name.StartsWith('S-1-')) { return $name }
  return ([Security.Principal.NTAccount]::new($name)).Translate([Security.Principal.SecurityIdentifier]).Value
}
`;

/**
 * Читает COM-регистрацию и argv живого процесса независимо от service status Runtime.
 * Проверяет principal, обе native repetition и отсутствие повышения прав/хранимого пароля.
 */
export async function assertWindowsRegistration(
  commands: NativeCommands,
  config: NativeConfiguration,
  binary: string,
  pid: number,
): Promise<void> {
  const actual = await runPowerShell(
    commands,
    `
$name=${psString(config.id)}
${scheduler}
if ($null -eq $task) { throw 'Native task отсутствует' }
${argumentParser}
$definition=$task.Definition
$principal=$definition.Principal
$settings=$definition.Settings
$action=$definition.Actions.Item(1)
$triggers=@($definition.Triggers | ForEach-Object {
  $sid=$null
  if ($_.Type -eq 9) { $sid=Sid $_.UserId }
  @{ type=$_.Type; enabled=$_.Enabled; userSid=$sid;
     interval=[string]$_.Repetition.Interval; duration=[string]$_.Repetition.Duration;
     stopAtDurationEnd=$_.Repetition.StopAtDurationEnd; timeLimit=[string]$_.ExecutionTimeLimit;
     startBoundary=[string]$_.StartBoundary; endBoundary=[string]$_.EndBoundary }
} | Sort-Object { $_.type })
$process=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'
if ($null -eq $process) { throw 'Supervisor отсутствует' }
$owner=Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
$currentSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
@{
  description=$definition.RegistrationInfo.Description
  state=$task.State; enabled=$task.Enabled
  lastRunTime=$task.LastRunTime.ToUniversalTime().ToString('o')
  runningInstances=@($task.GetInstances(0) | ForEach-Object {
    @{ instanceGuid=$_.InstanceGuid; state=$_.State; currentAction=$_.CurrentAction; enginePid=$_.EnginePID }
  })
  principalSid=(Sid $principal.UserId); currentSid=$currentSid
  processOwner=$owner.Sid; logonType=$principal.LogonType; runLevel=$principal.RunLevel
  actionCount=$definition.Actions.Count; binary=$action.Path
  arguments=[NativeServiceArgv]::Parse('unused.exe '+$action.Arguments)
  processArgv=[NativeServiceArgv]::Parse($process.CommandLine)
  triggerCount=$definition.Triggers.Count; triggers=$triggers
  instances=$settings.MultipleInstances; timeLimit=$settings.ExecutionTimeLimit
  restartInterval=[string]$settings.RestartInterval; restartCount=$settings.RestartCount
} | ConvertTo-Json -Compress -Depth 5
`,
  );
  expect(actual).toMatchObject({
    description: config.marker,
    state: 4,
    enabled: true,
    logonType: 3,
    runLevel: 0,
    actionCount: 1,
    binary,
    arguments: ["unused.exe", "supervise", "--home", config.home],
    processArgv: [binary, "supervise", "--home", config.home],
    triggerCount: 2,
    instances: 2,
    timeLimit: "PT0S",
    restartInterval: "",
    restartCount: 0,
  });
  if (!actual || typeof actual !== "object" || !("currentSid" in actual)) {
    throw new Error("Нет SID текущего пользователя в native-наблюдении");
  }
  expect(typeof actual.currentSid).toBe("string");
  expect(actual).toMatchObject({
    principalSid: actual.currentSid,
    processOwner: actual.currentSid,
    triggers: [
      {
        type: 7,
        enabled: true,
        userSid: null,
        interval: "PT1M",
        duration: "",
        stopAtDurationEnd: false,
        timeLimit: "PT0S",
        endBoundary: "",
      },
      {
        type: 9,
        enabled: true,
        userSid: actual.currentSid,
        interval: "PT1M",
        duration: "",
        stopAtDurationEnd: false,
        timeLimit: "PT0S",
        endBoundary: "",
      },
    ],
  });
}

/**
 * Подтверждает отсутствие именно своей задачи через COM, не принимая ошибку manager за ENOENT.
 */
export async function assertWindowsAbsent(
  commands: NativeCommands,
  config: NativeConfiguration,
): Promise<void> {
  const exists = await runPowerShell(
    commands,
    `$name=${psString(config.id)}\n${scheduler}\n($null -ne $task) | ConvertTo-Json`,
  );
  expect(exists).toBe(false);
}

/**
 * Снимает readonly-состояние задачи до cleanup: последний результат, живые task instances,
 * точные action/argv и уже доступные события. Operational log не включается настройкой ОС.
 */
export async function readWindowsFailureSnapshot(
  commands: NativeCommands,
  config: NativeConfiguration,
  binary: string,
): Promise<unknown> {
  return runPowerShell(
    commands,
    `
$name=${psString(config.id)}
${scheduler}
$observation=@{ exists=($null -ne $task); capturedAt=[DateTime]::UtcNow.ToString('o') }
if ($null -ne $task) {
  $observation.state=$task.State
  $observation.enabled=$task.Enabled
  $observation.lastTaskResult=$task.LastTaskResult
  $observation.lastTaskResultHex=('0x{0:X8}' -f $task.LastTaskResult)
  $observation.lastRunTime=$task.LastRunTime.ToUniversalTime().ToString('o')
  $observation.nextRunTime=$task.NextRunTime.ToUniversalTime().ToString('o')
  $observation.xml=$task.Xml
  $observation.runningInstances=@($task.GetInstances(0) | ForEach-Object {
    @{ instanceGuid=$_.InstanceGuid; state=$_.State; currentAction=$_.CurrentAction; enginePid=$_.EnginePID }
  })
}
try {
  $observation.processes=@(Get-CimInstance Win32_Process -Filter "Name='relay-git-sync.exe'" |
    Where-Object { $_.ExecutablePath -eq ${psString(binary)} } | ForEach-Object {
      @{ pid=$_.ProcessId; parentPid=$_.ParentProcessId; sessionId=$_.SessionId;
         executable=$_.ExecutablePath; commandLine=$_.CommandLine; created=$_.CreationDate.ToUniversalTime().ToString('o') }
    })
} catch { $observation.processReadError=$_.Exception.Message }
try {
  $log=Get-WinEvent -ListLog 'Microsoft-Windows-TaskScheduler/Operational' -ErrorAction Stop
  $observation.eventLogEnabled=$log.IsEnabled
  if ($log.IsEnabled) {
    $xpath="*[EventData[Data[@Name='TaskName']='\\$name']]"
    $observation.events=@(Get-WinEvent -LogName $log.LogName -FilterXPath $xpath -MaxEvents 50 -ErrorAction Stop |
      ForEach-Object { $_.ToXml() })
  }
} catch { $observation.eventReadError=$_.Exception.Message }
$observation | ConvertTo-Json -Compress -Depth 8
`,
  );
}

/**
 * Аварийно завершает подтверждённый supervisor с явно заданным ненулевым кодом отказа.
 * TerminateProcess адресует удержанный handle после проверки executable/SID, не переоткрывает PID.
 * Не вызывает Task Scheduler Stop/End/Run и не выводит готовность из успешной инъекции.
 */
export async function crashWindowsSupervisor(
  commands: NativeCommands,
  binary: string,
  pid: number,
): Promise<void> {
  const result = await runPowerShell(
    commands,
    `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RelayNativeCrash {
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool TerminateProcess(IntPtr process, uint exitCode);
}
'@
$process=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'
if ($null -eq $process -or $process.ExecutablePath -ne ${psString(binary)}) { throw 'Чужой или исчезнувший PID' }
$owner=Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
if ($owner.Sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'Чужой пользователь процесса' }
$watched=[Diagnostics.Process]::GetProcessById(${pid})
try {
  $null=$watched.Handle
  if ($watched.MainModule.FileName -ne ${psString(binary)}) { throw 'Исполняемый файл PID изменился до crash' }
  if (-not [RelayNativeCrash]::TerminateProcess($watched.Handle, ${CRASH_EXIT_CODE})) {
    throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
  }
  if (-not $watched.WaitForExit(5000)) { throw 'Supervisor не завершился после TerminateProcess' }
  @{ pid=${pid}; method='TerminateProcess'; requestedExitCode=${CRASH_EXIT_CODE}; exitCode=$watched.ExitCode;
     exitCodeHex=('0x{0:X8}' -f $watched.ExitCode); exitedAt=[DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
} finally { $watched.Dispose() }
`,
  );
  expect(result).toMatchObject({
    pid,
    method: "TerminateProcess",
    requestedExitCode: CRASH_EXIT_CODE,
    exitCode: CRASH_EXIT_CODE,
    exitCodeHex: "0x00000056",
  });
}

/**
 * Аварийная уборка после отказа проверяемого disable. Не является успешной production cleanup.
 * Удаляет лишь свою задачу с совпавшим маркером; пароль и elevation не используются.
 */
export async function removeWindowsRegistration(
  commands: NativeCommands,
  config: NativeConfiguration,
): Promise<void> {
  const result = await runPowerShell(
    commands,
    `
$name=${psString(config.id)}
${scheduler}
if ($null -ne $task) {
  if ($task.Definition.RegistrationInfo.Description -ne ${psString(config.marker)}) { throw 'Чужая native task' }
  $task.Enabled=$false
  $task.Stop(0)
  $folder.DeleteTask($name, 0)
}
$true | ConvertTo-Json
`,
  );
  expect(result).toBe(true);
}
