import type { ServerInstanceList } from "@relay/contracts";
import type { RelayHomeStatus } from "@relay/project-runtime";

/**
 * Фактически запущенный CLI; в source-сценарии executable указывает на Bun.
 */
export interface RelayExecutableStatus {
  /* Версия приложения из manifest. */
  readonly version: string;
  /* Физический путь; null у встраиваемого вызова без предоставленного executablePath. */
  readonly executablePath: string | null;
}

/**
 * Общая диагностическая сводка CLI; данные home и реестра сохраняют собственные точные контракты.
 */
export interface RelayStatus extends RelayHomeStatus {
  /* Версия JSON-сводки. */
  readonly version: 1;
  /* Версия приложения и физический путь фактически исполняемого CLI либо Bun для source-входа. */
  readonly cli: RelayExecutableStatus;
  /* Только известные публичные переменные Relay; undefined представлен null. */
  readonly environment: Readonly<Record<string, string | null>>;
  /* Все регистрации того же home с независимым живым health. */
  readonly servers: ServerInstanceList;
}
