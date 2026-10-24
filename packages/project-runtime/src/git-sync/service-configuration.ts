import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import { RelayError } from "@relay/contracts";
import { gitSyncMessages as messages } from "./git-sync.messages";
import type { ServiceConfiguration, ServiceConfigurationInput } from "./service.types";

/**
 * Экранирует XML/plist, сохраняя пробелы и Unicode в значении одного элемента.
 */
export function escapeServiceXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Кодирует один аргумент systemd ExecStart без shell, подстановок specifier и переменных.
 */
export function quoteSystemdArgument(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$$$")}"`;
}

/**
 * Кодирует один аргумент Windows CommandLineToArgvW, включая завершающие обратные слеши.
 */
export function quoteWindowsArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}

/**
 * Генерирует реальный unit, LaunchAgent или logon task только текущего пользователя.
 * Не выполняет native-команды; абсолютный executable и home сохраняются раздельными аргументами.
 */
export function createServiceConfiguration(input: ServiceConfigurationInput): ServiceConfiguration {
  for (const value of [input.binary, input.home, input.userHome, input.userName ?? ""]) {
    if (
      [...value].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    ) {
      throw new RelayError("INVALID_ARGUMENT", messages.invalidServicePath, 2);
    }
  }
  const identity =
    input.platform === "win32" ? `${input.userName?.toLowerCase()}\0${input.home}` : input.home;
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  const marker = `Relay Git Sync managed: ${hash}`;
  const args = [input.binary, "supervise", "--home", input.home];
  if (input.platform === "linux") {
    const id = `relay-git-sync-${hash}.service`;
    return {
      platform: input.platform,
      id,
      marker,
      home: input.home,
      path: posix.join(input.userHome, ".config/systemd/user", id),
      content: `# ${marker}\n[Unit]\nDescription=Relay Git Sync\nAfter=network.target\n\n[Service]\nType=exec\nExecStart=${args.map(quoteSystemdArgument).join(" ")}\nRestart=on-failure\nRestartSec=5\nKillMode=control-group\nTimeoutStopSec=20\n\n[Install]\nWantedBy=default.target\n`,
    };
  }
  if (input.platform === "darwin") {
    const id = `dev.relay.git-sync.${hash}`;
    return {
      platform: input.platform,
      id,
      marker,
      home: input.home,
      path: posix.join(input.userHome, "Library/LaunchAgents", `${id}.plist`),
      content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${id}</string>\n<key>Comment</key><string>${marker}</string>\n<key>ProgramArguments</key><array>${args.map((arg) => `<string>${escapeServiceXml(arg)}</string>`).join("")}</array>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ThrottleInterval</key><integer>5</integer>\n<key>ProcessType</key><string>Background</string>\n</dict></plist>\n`,
    };
  }
  if (!input.userName?.trim()) {
    throw new RelayError("GIT_SYNC_SERVICE_IDENTITY", messages.serviceIdentity);
  }
  const id = `Relay Git Sync ${hash}`;
  const user = escapeServiceXml(input.userName);
  return {
    platform: input.platform,
    id,
    marker,
    home: input.home,
    path: win32.join(input.userHome, "AppData/Local/Relay/services", `${hash}.xml`),
    content: `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\n<RegistrationInfo><Description>${marker}</Description></RegistrationInfo>\n<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${user}</UserId></LogonTrigger></Triggers>\n<Principals><Principal id="RelayUser"><UserId>${user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>\n<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><Enabled>true</Enabled><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings>\n<Actions Context="RelayUser"><Exec><Command>${escapeServiceXml(input.binary)}</Command><Arguments>${escapeServiceXml(args.slice(1).map(quoteWindowsArgument).join(" "))}</Arguments></Exec></Actions>\n</Task>\n`,
  };
}
