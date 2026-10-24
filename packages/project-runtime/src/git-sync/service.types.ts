import type { GitSyncSupervisorStatus } from "./supervisor.types";

/**
 * Поддержанные нативные менеджеры пользовательских служб.
 */
export type ServicePlatform = "linux" | "darwin" | "win32";

/**
 * Явные пользовательские действия над автозапуском supervisor.
 */
export type GitSyncServiceAction = "enable" | "disable" | "status";

/**
 * Владение только служебными файлами; подмена позволяет проверять чужую платформу без записи на хост.
 */
export interface ServiceFileStore {
  /* Читает файл; undefined означает только ENOENT. */
  readonly read: (path: string, platform: ServicePlatform) => string | undefined;
  /* Атомарно публикует целый файл, создавая родительский каталог. */
  readonly write: (path: string, content: string, platform: ServicePlatform) => void;
  /* Удаляет только указанный файл, сохраняя данные проектов. */
  readonly remove: (path: string) => void;
}

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
 * Сгенерированная конфигурация только одной службы Relay для данного home.
 */
export interface ServiceConfiguration {
  /* Платформа менеджера. */
  readonly platform: ServicePlatform;
  /* Уникальное системное имя, включающее хеш home. */
  readonly id: string;
  /* Маркер владения, проверяемый перед заменой/удалением. */
  readonly marker: string;
  /* Путь конфигурации службы в каталоге пользователя. */
  readonly path: string;
  /* Полный unit, plist или XML; executable и home экранированы для целевого формата. */
  readonly content: string;
  /* Корень данных, не удаляемый при disable. */
  readonly home: string;
}

/**
 * Состояние системной службы, отдельное от состояния синхронизации конкретного проекта.
 */
export interface GitSyncServiceStatus {
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
  /* Фактическое наличие регистрации в native manager. */
  readonly registered: boolean;
  /* Native-флаг автозапуска; null, если manager не предоставляет стабильного машинного API. */
  readonly enabled: boolean | null;
  /* Нативное состояние; unknown означает, что менеджер не сообщает его структурно. */
  readonly state: "running" | "stopped" | "unknown";
  /* Условия login/linger без скрытого изменения политики ОС. */
  readonly startup: string;
  /* Фактический код последнего запроса менеджеру. */
  readonly managerExitCode: number;
  /* Подтверждённая local health-ответом отзывчивость; не выводится из native state. */
  readonly supervisor: GitSyncSupervisorStatus;
}

/**
 * Машинное наблюдение платформенного менеджера, не являющееся readiness приложения.
 */
export interface NativeServiceStatus {
  /* Наличие unit/job/task в менеджере. */
  readonly registered: boolean;
  /* Автозапуск native manager; null без стабильного API. */
  readonly enabled: boolean | null;
  /* Фактическое нативное состояние; launchd text не разбирается как API. */
  readonly state: "running" | "stopped" | "unknown";
  /* Фактический exit code последней системной команды. */
  readonly managerExitCode: number;
}
