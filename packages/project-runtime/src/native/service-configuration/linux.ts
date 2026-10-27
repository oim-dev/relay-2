import { posix } from "node:path";
import type { ServiceConfiguration, UserServiceDefinition } from "../user-service/service.types";

/**
 * Кодирует один аргумент systemd ExecStart без shell, подстановок specifier и переменных.
 */
export function quoteSystemdArgument(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$$$")}"`;
}

/**
 * Генерирует user-systemd unit с exec-переходником: systemd запрещает кавычки/backslash в executable.
 * Фиксированный shell-код не интерпретирует пути и сохраняет PID через exec.
 */
export function createLinuxServiceConfiguration(
  input: UserServiceDefinition,
): ServiceConfiguration {
  const id = `relay-${input.name}-${input.hash}.service`;
  const command = [
    "/bin/sh",
    "-c",
    'exec "$@"',
    `relay-${input.name}`,
    input.binary,
    ...input.args,
  ];
  return {
    platform: "linux",
    id,
    marker: input.marker,
    home: input.home,
    path: posix.join(input.userHome, ".config/systemd/user", id),
    content: `# ${input.marker}\n[Unit]\nDescription=${input.description}\nAfter=network.target\n\n[Service]\nType=exec\nExecStart=${command.map(quoteSystemdArgument).join(" ")}\nRestart=on-failure\nRestartSec=5\nKillMode=control-group\nTimeoutStopSec=20\n\n[Install]\nWantedBy=default.target\n`,
  };
}
