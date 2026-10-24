import { RelayError } from "@relay/contracts";
import type { GitSyncEnvironment } from "./client.types";
import { gitSyncMessages as messages } from "./git-sync.messages";
import { runServiceCommand as native } from "./service-command";
import { serviceFiles } from "./service-files";
import type {
  GitSyncServiceAction,
  NativeServiceStatus,
  ServiceConfiguration,
} from "./service.types";

/**
 * Читает имя текущего Windows-пользователя в UTF-8, не полагаясь на OEM-кодировку whoami.exe.
 */
export async function currentWindowsUser(environment: GitSyncEnvironment): Promise<string> {
  const script =
    "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); [Security.Principal.WindowsIdentity]::GetCurrent().Name";
  const identity = await native(environment, "powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ]);
  return identity.stdout.replace(/^\uFEFF/u, "").trim();
}

/**
 * Запрашивает Windows Task Scheduler через COM с машинным HRESULT отсутствия задачи.
 * EncodedCommand переносит Unicode/кавычки без cmd.exe и локализованного разбора schtasks.
 */
export async function windowsState(
  configuration: ServiceConfiguration,
  environment: GitSyncEnvironment,
): Promise<NativeServiceStatus> {
  const name = configuration.id.replaceAll("'", "''");
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $s=New-Object -ComObject Schedule.Service; $s.Connect(); try { $t=$s.GetFolder('\\').GetTask('${name}'); @{exists=$true; state=$t.State; enabled=$t.Enabled; description=$t.Definition.RegistrationInfo.Description} | ConvertTo-Json -Compress } catch { $failure=$_.Exception; while ($failure.InnerException) { $failure=$failure.InnerException }; if ($failure.HResult -eq -2147024894) { '{"exists":false}' } else { throw } }`;
  const result = await native(environment, "powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ]);
  let value: unknown;
  try {
    value = JSON.parse(result.stdout.replace(/^\uFEFF/u, ""));
  } catch {
    throw new RelayError("GIT_SYNC_SERVICE_PROTOCOL", messages.invalidResponse);
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("exists" in value) ||
    typeof value.exists !== "boolean"
  ) {
    throw new RelayError("GIT_SYNC_SERVICE_PROTOCOL", messages.invalidResponse);
  }
  if (!value.exists) {
    return {
      registered: false,
      enabled: false,
      state: "stopped",
      managerExitCode: result.exitCode,
    };
  }
  if (!("description" in value) || value.description !== configuration.marker) {
    throw new RelayError("GIT_SYNC_SERVICE_OWNERSHIP", messages.serviceOwnership, 4, {
      id: configuration.id,
    });
  }
  if (
    !("state" in value) ||
    typeof value.state !== "number" ||
    !("enabled" in value) ||
    typeof value.enabled !== "boolean"
  ) {
    throw new RelayError("GIT_SYNC_SERVICE_PROTOCOL", messages.invalidResponse);
  }
  let state: NativeServiceStatus["state"] = "unknown";
  if (value.state === 4) {
    state = "running";
  } else if (value.state === 1 || value.state === 3) {
    state = "stopped";
  }
  return { registered: true, enabled: value.enabled, state, managerExitCode: result.exitCode };
}

/**
 * Регистрирует и запускает настоящую logon-задачу Windows с InteractiveToken текущего пользователя.
 */
export async function windowsService(
  action: GitSyncServiceAction,
  config: ServiceConfiguration,
  environment: GitSyncEnvironment,
): Promise<NativeServiceStatus> {
  const state = await windowsState(config, environment);
  if (action === "status") {
    return state;
  }
  if (action === "disable") {
    if (state.state === "running") {
      await native(environment, "schtasks.exe", ["/End", "/TN", config.id]);
    }
    if (state.registered) {
      await native(environment, "schtasks.exe", ["/Delete", "/TN", config.id, "/F"]);
    }
    (environment.serviceFiles ?? serviceFiles).remove(config.path);
    return { registered: false, enabled: false, state: "stopped", managerExitCode: 0 };
  }
  await native(environment, "schtasks.exe", [
    "/Create",
    "/TN",
    config.id,
    "/XML",
    config.path,
    "/F",
  ]);
  if (state.state === "running") {
    await native(environment, "schtasks.exe", ["/End", "/TN", config.id]);
  }
  await native(environment, "schtasks.exe", ["/Run", "/TN", config.id]);
  return windowsState(config, environment);
}
