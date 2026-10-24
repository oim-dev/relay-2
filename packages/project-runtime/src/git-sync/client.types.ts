import type { GitSyncRequest } from "@relay/contracts";
import type { RuntimeOptions } from "../configuration/runtime-options.types";
import type { ProcessRunner } from "./process.types";
import type { GitSyncSupervisorStatus } from "./supervisor.types";
import type {
  GitSyncServiceAction,
  GitSyncServiceStatus,
  ServicePlatform,
  ServiceFileStore,
} from "./service.types";

/**
 * Изолированная среда локального компонента; переменные Relay извлекает вызывающий CLI.
 */
export interface GitSyncEnvironment {
  /* Каталог запуска CLI; используется для относительного override и поиска PATH. */
  readonly cwd: string;
  /* Полное окружение дочерних процессов. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /* Явный RELAY_GIT_SYNC_BIN; отсутствие включает sibling/PATH/dev-discovery. */
  readonly binary?: string;
  /* Исполняемый файл текущей CLI для поиска совместимого соседнего компонента. */
  readonly executablePath: string;
  /* Версия выпуска CLI для проверки --version компонента. */
  readonly version: string;
  /* Домашний каталог текущего пользователя для user-systemd/LaunchAgent/Task Scheduler. */
  readonly userHome: string;
  /* Платформа службы; подмена используется тестами генераторов и native runner. */
  readonly platform?: ServicePlatform;
  /* UID пользователя macOS; отсутствие определяется текущим процессом. */
  readonly userId?: number;
  /* DOMAIN\user для Windows; отсутствие определяется native WindowsIdentity с UTF-8 выводом. */
  readonly userName?: string;
  /* Подменяемый native runner; production использует runNativeProcess. */
  readonly runner?: ProcessRunner;
  /* Файлы службы; тестовая подмена не пишет конфигурацию реального native manager. */
  readonly serviceFiles?: ServiceFileStore;
  /* Подмена health-границы в тестах native managers; true ожидает готовность после установки. */
  readonly supervisorProbe?: (
    home: string,
    waitForReady: boolean,
  ) => Promise<GitSyncSupervisorStatus>;
  /* Подмена технического SQLite-барьера в тестах manager; free требует реального захвата/release. */
  readonly supervisorLockProbe?: (home: string) => "free" | "busy";
  /* Deadline готовности после service enable; по умолчанию 10 секунд. */
  readonly readinessTimeoutMs?: number;
  /* Deadline запроса, по умолчанию 120 секунд; не ограничивает foreground supervise. */
  readonly timeoutMs?: number;
  /* Отмена запуска; listeners принадлежат отдельному процессному входу CLI. */
  readonly signal?: AbortSignal;
  /* Потоковые получатели foreground supervisor. */
  readonly stdout?: (text: string) => void;
  /* Потоковая диагностика foreground supervisor. */
  readonly stderr?: (text: string) => void;
}

/**
 * Процессный порт CLI; тесты ввода подменяют его без запуска процессов или системных служб.
 */
export interface GitSyncClient {
  /* Выполняет один версионированный запрос; ошибки компонента сохраняют code/exitCode/details. */
  readonly request: (request: GitSyncRequest) => Promise<unknown>;
  /* Управляет пользовательской службой данного home, не меняя проекты. */
  readonly service: (
    action: GitSyncServiceAction,
    options: RuntimeOptions,
  ) => Promise<GitSyncServiceStatus>;
  /* Проксирует foreground supervisor до его завершения или отмены. */
  readonly supervise: (options: RuntimeOptions) => Promise<number>;
}
