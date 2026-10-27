import { selectUserService } from "../native/user-service/select";
import { ownsServiceConfiguration } from "../native/user-service/files";
import {
  createServerServiceConfiguration,
  serverServicePlatformFailure,
} from "./service-configuration";
import { createServerServiceContext } from "./service-context";
import type { ServerEnvironment, ServerLaunch } from "./server.types";

/**
 * Регистрирует/удаляет user-service выбранного UUID через один native-адаптер.
 * Проверка локального ownership предшествует manager; отказ сохраняет чужой файл и регистрацию.
 * Windows stop-барьер получает lease именно Server. Health и конечное ожидание остановки
 * остаются у lifecycle клиента, а не у native manager.
 */
export async function controlServerService(
  action: "enable" | "disable",
  launch: ServerLaunch,
  environment: ServerEnvironment,
  binary = "",
): Promise<void> {
  const adapter = selectUserService(environment.platform, serverServicePlatformFailure);
  const context = createServerServiceContext(environment, adapter, launch);
  const userName = await adapter.resolveUserName(context, environment.userName);
  const config = createServerServiceConfiguration({
    platform: adapter.platform,
    binary,
    launch,
    userHome: environment.userHome,
    ...(userName ? { userName } : {}),
  });
  const installed = ownsServiceConfiguration(config, context);
  await adapter.register(action, config, context, installed);
}
