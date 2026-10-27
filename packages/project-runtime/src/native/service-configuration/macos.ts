import { posix } from "node:path";
import type { ServiceConfiguration, UserServiceDefinition } from "../user-service/service.types";
import { escapeServiceXml } from "./xml";

/**
 * Генерирует LaunchAgent с отдельными ProgramArguments и restart только после неуспешного выхода.
 */
export function createMacosServiceConfiguration(
  input: UserServiceDefinition,
): ServiceConfiguration {
  const id = `dev.relay.${input.name}.${input.hash}`;
  const args = [input.binary, ...input.args];
  const body = [
    '<plist version="1.0"><dict>',
    `<key>Label</key><string>${id}</string>`,
    `<key>Comment</key><string>${input.marker}</string>`,
    `<key>ProgramArguments</key><array>${args.map((arg) => `<string>${escapeServiceXml(arg)}</string>`).join("")}</array>`,
    "<key>RunAtLoad</key><true/>",
    "<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
    "<key>ThrottleInterval</key><integer>5</integer>",
    "<key>ProcessType</key><string>Background</string>",
    "</dict></plist>",
  ].join(input.xmlBodySeparator);
  return {
    platform: "darwin",
    id,
    marker: input.marker,
    home: input.home,
    path: posix.join(input.userHome, "Library/LaunchAgents", `${id}.plist`),
    content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n${body}\n`,
  };
}
