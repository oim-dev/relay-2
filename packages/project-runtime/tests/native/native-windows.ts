import { expect } from "bun:test";
import { psString, type NativeCommands } from "./native-command";
import type { NativeConfiguration } from "./native-service.types";

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
 * Проверяет текущего principal, login action и отсутствие повышения прав/хранимого пароля.
 */
export async function assertWindowsRegistration(
  commands: NativeCommands,
  config: NativeConfiguration,
  binary: string,
  pid: number,
): Promise<void> {
  const actual = await commands.powershell(`
$name=${psString(config.id)}
${scheduler}
if ($null -eq $task) { throw 'Native task отсутствует' }
${argumentParser}
$definition=$task.Definition
$principal=$definition.Principal
$settings=$definition.Settings
$action=$definition.Actions.Item(1)
$trigger=$definition.Triggers.Item(1)
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
  triggerCount=$definition.Triggers.Count; triggerType=$trigger.Type
  triggerEnabled=$trigger.Enabled; triggerSid=(Sid $trigger.UserId)
  instances=$settings.MultipleInstances; timeLimit=$settings.ExecutionTimeLimit
  restartInterval=$settings.RestartInterval; restartCount=$settings.RestartCount
} | ConvertTo-Json -Compress -Depth 5
`);
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
    triggerCount: 1,
    triggerType: 9,
    triggerEnabled: true,
    instances: 2,
    timeLimit: "PT0S",
    restartInterval: "PT1M",
    restartCount: 999,
  });
  if (!actual || typeof actual !== "object" || !("currentSid" in actual)) {
    throw new Error("Нет SID текущего пользователя в native-наблюдении");
  }
  expect(typeof actual.currentSid).toBe("string");
  expect(actual).toMatchObject({
    principalSid: actual.currentSid,
    triggerSid: actual.currentSid,
    processOwner: actual.currentSid,
  });
}

/**
 * Подтверждает отсутствие именно своей задачи через COM, не принимая ошибку manager за ENOENT.
 */
export async function assertWindowsAbsent(
  commands: NativeCommands,
  config: NativeConfiguration,
): Promise<void> {
  const exists = await commands.powershell(
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
  return commands.powershell(`
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
`);
}

/**
 * Аварийно завершает подтверждённый supervisor; /End здесь нельзя использовать:
 * намеренная остановка задачи не проверяет RestartOnFailure.
 */
export async function crashWindowsSupervisor(
  commands: NativeCommands,
  binary: string,
  pid: number,
): Promise<void> {
  const result = await commands.powershell(`
$process=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'
if ($null -eq $process -or $process.ExecutablePath -ne ${psString(binary)}) { throw 'Чужой или исчезнувший PID' }
$owner=Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
if ($owner.Sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'Чужой пользователь процесса' }
Stop-Process -Id ${pid} -Force -ErrorAction Stop
$true | ConvertTo-Json
`);
  expect(result).toBe(true);
}

/**
 * Аварийная уборка после отказа проверяемого disable. Не является успешной production cleanup.
 * Удаляет лишь свою задачу с совпавшим маркером; пароль и elevation не используются.
 */
export async function removeWindowsRegistration(
  commands: NativeCommands,
  config: NativeConfiguration,
): Promise<void> {
  const result = await commands.powershell(`
$name=${psString(config.id)}
${scheduler}
if ($null -ne $task) {
  if ($task.Definition.RegistrationInfo.Description -ne ${psString(config.marker)}) { throw 'Чужая native task' }
  $task.Stop(0)
  $folder.DeleteTask($name, 0)
}
$true | ConvertTo-Json
`);
  expect(result).toBe(true);
}
