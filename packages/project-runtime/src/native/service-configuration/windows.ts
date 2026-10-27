import { win32 } from "node:path";
import type { ServiceConfiguration, UserServiceDefinition } from "../user-service/service.types";
import { escapeServiceXml } from "./xml";

/**
 * Кодирует один аргумент Windows CommandLineToArgvW, включая завершающие обратные слеши.
 */
export function quoteWindowsArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}

/**
 * Генерирует Task Scheduler XML с прямым Exec текущего пользователя.
 * Два бесконечных repetition поддерживают enabled task после любого выхода; ручного Run нет.
 */
export function createWindowsServiceConfiguration(
  input: UserServiceDefinition,
): ServiceConfiguration {
  if (!input.userName?.trim()) {
    throw input.identityFailure();
  }
  const id = `${input.displayName} ${input.hash}`;
  const user = escapeServiceXml(input.userName);
  const triggerPolicy =
    "<Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><ExecutionTimeLimit>PT0S</ExecutionTimeLimit>";
  const body = [
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    `<RegistrationInfo><Description>${input.marker}</Description></RegistrationInfo>`,
    `<Triggers><LogonTrigger><Enabled>true</Enabled>${triggerPolicy}<UserId>${user}</UserId></LogonTrigger><RegistrationTrigger><Enabled>true</Enabled>${triggerPolicy}</RegistrationTrigger></Triggers>`,
    `<Principals><Principal id="RelayUser"><UserId>${user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>`,
    "<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><Enabled>true</Enabled><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>",
    `<Actions Context="RelayUser"><Exec><Command>${escapeServiceXml(input.binary)}</Command><Arguments>${escapeServiceXml(input.args.map(quoteWindowsArgument).join(" "))}</Arguments></Exec></Actions>`,
    "</Task>",
  ].join(input.xmlBodySeparator);
  return {
    platform: "win32",
    id,
    marker: input.marker,
    home: input.home,
    path: win32.join(input.userHome, "AppData/Local/Relay/services", input.taskFileName),
    content: `<?xml version="1.0" encoding="UTF-16"?>\n${body}\n`,
  };
}
