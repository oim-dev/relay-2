import { createHash } from "node:crypto";
import { RelayError } from "@relay/contracts";
import { selectUserService } from "../native/user-service/select";
import { gitSyncMessages as messages } from "./git-sync.messages";
import type { ServiceConfiguration, ServiceConfigurationInput } from "./service.types";

/**
 * Сохраняет публичный отказ выбора manager вместо общего PLATFORM_UNSUPPORTED.
 */
export function gitSyncServicePlatformFailure(): RelayError {
  return new RelayError("GIT_SYNC_SERVICE_PLATFORM", messages.servicePlatform, 2);
}

/**
 * Генерирует конфигурацию supervisor, сохраняя стабильный home/user identity и exact argv.
 * Сценарий владеет хешем и командой; формат, namespace и пути manager принадлежат native-адаптеру.
 * Не запускает процессов и не пишет файлы; управляющие символы отклоняются до генерации.
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
  const adapter = selectUserService(input.platform, gitSyncServicePlatformFailure);
  const identity = adapter.scopeIdentity(input.home, input.userName);
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return adapter.configure({
    name: "git-sync",
    displayName: "Relay Git Sync",
    description: "Relay Git Sync",
    hash,
    marker: `Relay Git Sync managed: ${hash}`,
    taskFileName: `${hash}.xml`,
    xmlBodySeparator: "\n",
    binary: input.binary,
    args: ["supervise", "--home", input.home],
    home: input.home,
    userHome: input.userHome,
    ...(input.userName !== undefined ? { userName: input.userName } : {}),
    /**
     * Сохраняет предметный отказ отсутствующей identity, не подставляя другого пользователя.
     */
    identityFailure: (): RelayError =>
      new RelayError("GIT_SYNC_SERVICE_IDENTITY", messages.serviceIdentity),
  });
}
