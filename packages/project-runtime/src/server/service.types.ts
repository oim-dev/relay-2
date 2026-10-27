import type { NativePlatform } from "../native/platform.types";
import type { ServerLaunch } from "./server.types";

/**
 * Чистый вход генератора одной независимой native-службы сервера.
 */
export interface ServerServiceInput {
  /* Целевая платформа; не зависит от хоста теста. */
  readonly platform: NativePlatform;
  /* Совместимый абсолютный executable. */
  readonly binary: string;
  /* Проверенный манифест с cwd/config/home/actor. */
  readonly launch: ServerLaunch;
  /* Домашний каталог текущего пользователя для конфигурации manager. */
  readonly userHome: string;
  /* Windows DOMAIN\user для InteractiveToken; обязателен только на Windows. */
  readonly userName?: string;
}
