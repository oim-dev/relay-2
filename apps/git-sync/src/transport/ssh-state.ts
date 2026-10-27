import { join } from "node:path";
import { RelayError } from "@relay/contracts";
import { readLocalJson, writeLocalJson } from "../local/files";
import { appMessages } from "../app/app.messages";
import { requestObject } from "../app/protocol";
import type { SshCapability } from "./ssh-profile.types";

/**
 * Сохраняет лишь безопасную характеристику профиля; значения команд и ключей остаются приватными.
 */
export function saveSshCapability(repository: string, capability: SshCapability): void {
  writeLocalJson(join(repository, "relay-ssh-profile.json"), capability);
}

/**
 * Читает последний проверенный профиль без Git/SSH subprocess; отсутствие остаётся неизвестным.
 */
export function readSshCapability(repository: string): SshCapability | null {
  const value = readLocalJson(join(repository, "relay-ssh-profile.json"));
  if (value === undefined) {
    return null;
  }
  const item = requestObject(value);
  const mode = item.mode;
  const source = item.source;
  if (
    (mode !== "not-used" &&
      mode !== "custom" &&
      mode !== "openssh-foreground" &&
      mode !== "unverified") ||
    (source !== null &&
      source !== "default" &&
      source !== "GIT_SSH_COMMAND" &&
      source !== "GIT_SSH" &&
      source !== "GIT_SSH_VARIANT" &&
      source !== "core.sshCommand" &&
      source !== "ssh.variant") ||
    (item.implementation !== null && typeof item.implementation !== "string") ||
    !Array.isArray(item.options) ||
    !item.options.every(
      (option) => option === "ForkAfterAuthentication=no" || option === "ControlPersist=no",
    )
  ) {
    throw new RelayError("GIT_SYNC_STATE_INVALID", appMessages.state, 4);
  }
  return { mode, source, implementation: item.implementation, options: item.options };
}
