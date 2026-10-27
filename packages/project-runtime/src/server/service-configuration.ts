import { createHash } from "node:crypto";
import { RelayError } from "@relay/contracts";
import { selectUserService } from "../native/user-service/select";
import type { ServiceConfiguration } from "../native/user-service/service.types";
import { serverMessages as messages } from "./server.messages";
import type { ServerServiceInput } from "./service.types";

/**
 * Сохраняет публичный Server-код при неподдержанном manager.
 */
export function serverServicePlatformFailure(): RelayError {
  return new RelayError("SERVER_SERVICE_PLATFORM", messages.unsupported, 2);
}

/**
 * Генерирует независимую службу Server UUID с неизменным home/instance hash и run --launch.
 * Identity и argv принадлежат Server; формат и расположение native manager выбирает адаптер.
 * Не выполняет native-команды и не пишет файлы; управляющие символы запрещены до генерации.
 */
export function createServerServiceConfiguration(input: ServerServiceInput): ServiceConfiguration {
  const { launch } = input;
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
  return selectUserService(input.platform, serverServicePlatformFailure).configure({
    name: "server",
    displayName: "Relay Server",
    description: `Relay Server ${launch.instanceId}`,
    hash,
    marker: `Relay Server managed: ${hash}`,
    taskFileName: `server-${hash}.xml`,
    xmlBodySeparator: "",
    binary: input.binary,
    args: ["run", "--launch", launch.path],
    home: launch.home,
    userHome: input.userHome,
    ...(input.userName !== undefined ? { userName: input.userName } : {}),
    /**
     * Отсутствующий InteractiveToken principal не подменяется другим пользователем.
     */
    identityFailure: (): RelayError =>
      new RelayError("SERVER_SERVICE_IDENTITY", messages.invalidInput, 2),
  });
}
