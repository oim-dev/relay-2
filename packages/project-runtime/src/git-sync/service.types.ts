import type { GitSyncSupervisorStatus } from "./supervisor.types";
import type { NativePlatform } from "../native/platform.types";
import type { NativeServiceStatus, UserServiceAction } from "../native/user-service/service.types";

export type {
  ServiceConfiguration,
  ServiceFileStore,
  NativeServiceStatus,
} from "../native/user-service/service.types";

/**
 * Поддержанные нативные менеджеры пользовательских служб.
 */
export type ServicePlatform = NativePlatform;

/**
 * Явные пользовательские действия над автозапуском supervisor.
 */
export type GitSyncServiceAction = UserServiceAction;

/**
 * Вход чистого генератора служебной конфигурации; все пути уже абсолютные.
 */
export interface ServiceConfigurationInput {
  /* Платформа целевого менеджера, независимая от машины теста. */
  readonly platform: ServicePlatform;
  /* Единственный абсолютный executable relay-git-sync согласованного выпуска. */
  readonly binary: string;
  /* Абсолютный корень локальных данных, передаваемый через --home. */
  readonly home: string;
  /* Домашний каталог владельца службы. */
  readonly userHome: string;
  /* Полное Windows-имя пользователя для InteractiveToken; для других платформ не нужно. */
  readonly userName?: string;
}

/**
 * Состояние системной службы, отдельное от состояния синхронизации конкретного проекта.
 */
export interface GitSyncServiceStatus extends NativeServiceStatus {
  /* Нативная платформа менеджера. */
  readonly platform: ServicePlatform;
  /* Системное имя только этой службы Relay. */
  readonly id: string;
  /* Путь сохранённой служебной конфигурации. */
  readonly configPath: string;
  /* Локальные данные supervisor. */
  readonly home: string;
  /* Наличие принадлежащей Relay конфигурации. */
  readonly installed: boolean;
  /* Желаемая регистрация, зафиксированная наличием принадлежащего Relay файла. */
  readonly desiredRegistration: "enabled" | "disabled";
  /* Условия login/linger без скрытого изменения политики ОС. */
  readonly startup: string;
  /* Подтверждённая local health-ответом отзывчивость; не выводится из native state. */
  readonly supervisor: GitSyncSupervisorStatus;
}
