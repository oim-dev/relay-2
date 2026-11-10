import type { GitSyncRequest } from "@relay/contracts";
import type { ProcessRunner } from "./process.types";
import type { GitSyncSupervisorStatus } from "./supervisor.types";
import type { ServicePlatform, ServiceFileStore } from "./service.types";

/**
 * Изолированная среда request-порта CLI; переменные Relay извлекает вызывающее приложение.
 * Поля native-служб/потоков сохраняются для общих Runtime helpers и ServerEnvironment,
 * но createGitSyncClient использует только обнаружение CLI и короткий request runner.
 */
export interface GitSyncEnvironment {
  /* Каталог вызывающего приложения; используется для относительного override и поиска PATH. */
  readonly cwd: string;
  /* Полное окружение дочерних процессов. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /* Override executable; createGitSyncClient получает CLI из RELAY_CLI_BIN, иначе использует discovery. */
  readonly binary?: string;
  /* Исполняемый файл вызывающего приложения для поиска соседнего relay согласованного выпуска. */
  readonly executablePath: string;
  /* Версия выпуска вызывающего приложения для проверки relay --version. */
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
  /* Deadline subprocess: request по умолчанию 120 s, auto не более 10 s; native helpers используют свои defaults. */
  readonly timeoutMs?: number;
  /* Отмена запуска; listeners принадлежат отдельному процессному входу CLI. */
  readonly signal?: AbortSignal;
  /* Потоковый stdout общих native helpers/Server foreground; request возвращает JSON, не поток. */
  readonly stdout?: (text: string) => void;
  /* Потоковый stderr общих native helpers/Server foreground; request сохраняет диагностику ошибки. */
  readonly stderr?: (text: string) => void;
}

/**
 * Только версионированный request-порт к relay --git-sync-request; службами и foreground не управляет.
 */
export interface GitSyncClient {
  /* Выполняет один raw versioned envelope; ошибки CLI сохраняют code/exitCode/details. */
  readonly request: (request: GitSyncRequest) => Promise<unknown>;
}
