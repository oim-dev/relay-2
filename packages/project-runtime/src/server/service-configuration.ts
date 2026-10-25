import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import { RelayError } from "@relay/contracts";
import {
  escapeServiceXml as xml,
  quoteSystemdArgument,
  quoteWindowsArgument,
} from "../git-sync/service-configuration";
import type { ServiceConfiguration } from "../git-sync/service.types";
import { serverMessages as messages } from "./server.messages";
import type { ServerServiceInput } from "./service.types";

/**
 * Генерирует user-service выбранного UUID с прямым foreground Exec и явным launch-манифестом.
 * Shell на Linux только exec-переходник фиксированной формы; пути не интерпретируются как код.
 * Регистрация переживает login до явного stop; linger/elevation не включаются.
 */
export function createServerServiceConfiguration(input: ServerServiceInput): ServiceConfiguration {
  const { launch, platform } = input;
  for (const value of [
    input.binary,
    input.userHome,
    input.userName ?? "",
    launch.path,
    launch.home,
  ]) {
    if (
      [...value].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    ) {
      throw new RelayError("INVALID_ARGUMENT", messages.invalidInput, 2);
    }
  }
  const hash = createHash("sha256")
    .update(`${launch.home}\0${launch.instanceId}`)
    .digest("hex")
    .slice(0, 24);
  const marker = `Relay Server managed: ${hash}`;
  const args = [input.binary, "run", "--launch", launch.path];
  if (platform === "linux") {
    const id = `relay-server-${hash}.service`;
    const command = ["/bin/sh", "-c", 'exec "$@"', "relay-server", ...args];
    return {
      platform,
      id,
      marker,
      home: launch.home,
      path: posix.join(input.userHome, ".config/systemd/user", id),
      content: `# ${marker}\n[Unit]\nDescription=Relay Server ${launch.instanceId}\nAfter=network.target\n\n[Service]\nType=exec\nExecStart=${command.map(quoteSystemdArgument).join(" ")}\nRestart=on-failure\nRestartSec=5\nKillMode=control-group\nTimeoutStopSec=20\n\n[Install]\nWantedBy=default.target\n`,
    };
  }
  if (platform === "darwin") {
    const id = `dev.relay.server.${hash}`;
    return {
      platform,
      id,
      marker,
      home: launch.home,
      path: posix.join(input.userHome, "Library/LaunchAgents", `${id}.plist`),
      content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${id}</string><key>Comment</key><string>${marker}</string><key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>5</integer><key>ProcessType</key><string>Background</string></dict></plist>\n`,
    };
  }
  if (!input.userName?.trim()) {
    throw new RelayError("SERVER_SERVICE_IDENTITY", messages.invalidInput, 2);
  }
  const id = `Relay Server ${hash}`;
  const user = xml(input.userName);
  const repetition =
    "<Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><ExecutionTimeLimit>PT0S</ExecutionTimeLimit>";
  return {
    platform,
    id,
    marker,
    home: launch.home,
    path: win32.join(input.userHome, "AppData/Local/Relay/services", `server-${hash}.xml`),
    content: `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>${marker}</Description></RegistrationInfo><Triggers><LogonTrigger><Enabled>true</Enabled>${repetition}<UserId>${user}</UserId></LogonTrigger><RegistrationTrigger><Enabled>true</Enabled>${repetition}</RegistrationTrigger></Triggers><Principals><Principal id="RelayUser"><UserId>${user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><Enabled>true</Enabled><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings><Actions Context="RelayUser"><Exec><Command>${xml(input.binary)}</Command><Arguments>${xml(args.slice(1).map(quoteWindowsArgument).join(" "))}</Arguments></Exec></Actions></Task>\n`,
  };
}
