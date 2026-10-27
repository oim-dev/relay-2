import type { NativePlatform } from "../platform.types";

/**
 * Явное действие над пользовательской регистрацией, не над readiness приложения.
 */
export type UserServiceAction = "enable" | "disable" | "status";

/**
 * Машинное наблюдение менеджера; running не подтверждает готовность приложения.
 */
export interface NativeServiceStatus {
  /* Наличие unit/job/task в менеджере. */
  readonly registered: boolean;
  /* Флаг автозапуска; null без стабильного машинного API. */
  readonly enabled: boolean | null;
  /* Нативное состояние; launchd text не разбирается как API. */
  readonly state: "running" | "stopped" | "unknown";
  /* Фактический exit code последнего запроса менеджеру. */
  readonly managerExitCode: number;
}

/**
 * Сгенерированная конфигурация одной службы; identity и команда принадлежат вызывающему.
 */
export interface ServiceConfiguration {
  /* Целевая платформа, не обязательно платформа хоста теста. */
  readonly platform: NativePlatform;
  /* Точное имя регистрации в системном менеджере. */
  readonly id: string;
  /* Маркер владения, проверяемый перед заменой/удалением. */
  readonly marker: string;
  /* Абсолютный путь служебной конфигурации. */
  readonly path: string;
  /* Полный unit/plist/XML с экранированными аргументами. */
  readonly content: string;
  /* Корень данных приложения; механизм службы его не изменяет. */
  readonly home: string;
}

/**
 * Описание запуска до кодирования в формат ОС. Хеш и argv рассчитывает владелец приложения.
 */
export interface UserServiceDefinition {
  /* Техническое имя компонента в пространстве Relay, например server. */
  readonly name: string;
  /* Полное отображаемое имя компонента, включая Relay. */
  readonly displayName: string;
  /* Описание экземпляра для systemd. */
  readonly description: string;
  /* Готовый стабильный хеш идентичности; адаптер его не пересчитывает. */
  readonly hash: string;
  /* Маркер владения, независимый от содержимого команды. */
  readonly marker: string;
  /* Имя файла экспортированной Windows task, включая .xml. */
  readonly taskFileName: string;
  /* Разделитель строк тела XML/plist; сохраняет существующую раскладку формата приложения. */
  readonly xmlBodySeparator: "" | "\n";
  /* Абсолютный executable согласованного выпуска. */
  readonly binary: string;
  /* Аргументы приложения без executable и без shell-кодирования. */
  readonly args: readonly string[];
  /* Абсолютный корень данных приложения. */
  readonly home: string;
  /* Домашний каталог владельца службы. */
  readonly userHome: string;
  /* DOMAIN\user для InteractiveToken; обязательно при Windows-генерации. */
  readonly userName?: string;
  /* Создаёт предметный отказ при отсутствии обязательной native identity. */
  readonly identityFailure: () => Error;
}

/**
 * Совместимый публичный порт подмены файлов для проверки чужой ОС без записи на хост.
 */
export interface ServiceFileStore {
  /* Читает файл; undefined означает только ENOENT. */
  readonly read: (path: string, platform: NativePlatform) => string | undefined;
  /* Атомарно публикует файл в кодировке целевой платформы. */
  readonly write: (path: string, content: string, platform: NativePlatform) => void;
  /* Удаляет только указанный служебный файл. */
  readonly remove: (path: string) => void;
}

/**
 * Файлы уже выбранного адаптера: кодировка и BOM больше не выбираются общим сценарием.
 */
export interface UserServiceFiles {
  /* Читает конфигурацию; undefined означает только ENOENT. */
  readonly read: (path: string) => string | undefined;
  /* Атомарно публикует конфигурацию после проверки владельца. */
  readonly write: (path: string, content: string) => void;
  /* Удаляет только указанную конфигурацию. */
  readonly remove: (path: string) => void;
}

/**
 * Команда менеджера с явным бюджетом; окружение и guardian связывает вызывающий порт.
 */
export interface UserServiceCommand {
  /* executable менеджера из PATH вызывающего. */
  readonly executable: string;
  /* Раздельные аргументы без shell. */
  readonly args: readonly string[];
  /* Положительный бюджет команды в миллисекундах. */
  readonly timeoutMs: number;
}

/**
 * Транспортный исход команды без интерпретации состояния manager.
 */
export interface UserServiceCommandResult {
  /* Фактический код завершения процесса. */
  readonly exitCode: number;
  /* Накопленный stdout. */
  readonly stdout: string;
  /* Накопленный stderr. */
  readonly stderr: string;
}

/**
 * Причина native-отказа; публичные code/message принадлежат приложению.
 */
export type UserServiceFailure =
  "command" | "ownership" | "identity" | "protocol" | "lock" | "cancelled";

/**
 * Порты одной операции. Native не знает ни Git Sync, ни launch/health/SQLite-схему приложения.
 * probeLease — мгновенная проверка, а не удержание владения для следующего запуска.
 */
export interface UserServiceContext {
  /* Запускает команду с cwd/env/signal и guardian вызывающего. */
  readonly run: (command: UserServiceCommand) => Promise<UserServiceCommandResult>;
  /* Файлы с уже выбранной кодировкой. */
  readonly files: UserServiceFiles;
  /* Создаёт публичный отказ, сохраняя native details и при наличии исходную причину. */
  readonly failure: (
    kind: UserServiceFailure,
    exitCode: number,
    details?: Readonly<Record<string, unknown>>,
    cause?: unknown,
  ) => Error;
  /* Технический захват/release lifetime mutex именно данного приложения. */
  readonly probeLease: () => "free" | "busy";
  /* Общий бюджет Windows stop-фазы и отдельный бюджет остальных команд, в ms. */
  readonly timeoutMs: number;
  /* Отмена операции; тот же сигнал передаётся командному порту. */
  readonly signal?: AbortSignal;
  /* Явный UID macOS для теста; production определяет текущий UID внутри адаптера. */
  readonly userId?: number;
}

/**
 * Реальная реализация одного user-manager. Два режима сохраняют разные гарантии вызывающих:
 * control наблюдает состояние supervisor; register меняет регистрацию Server без health/status.
 * register строже проверяет чужую POSIX-регистрацию при disable; Windows использует общий stop-барьер.
 */
export interface UserServiceAdapter {
  /* Поддержанная ОС данной реализации. */
  readonly platform: NativePlatform;
  /* Production-файлы в формате менеджера. */
  readonly files: UserServiceFiles;
  /* Разрешает home по синтаксису целевой ОС без чтения переменных Relay. */
  readonly resolveHome: (cwd: string, home: string | undefined, userHome: string) => string;
  /* Идентичность home в namespace пользователя manager; Windows добавляет DOMAIN\user. */
  readonly scopeIdentity: (home: string, userName?: string) => string;
  /* Определяет только необходимую менеджеру identity; POSIX сохраняет переданное значение. */
  readonly resolveUserName: (
    context: UserServiceContext,
    userName?: string,
  ) => Promise<string | undefined>;
  /* Чисто генерирует конфигурацию без обращения к ОС. */
  readonly configure: (definition: UserServiceDefinition) => ServiceConfiguration;
  /* Управляет регистрацией supervisor и возвращает нативное наблюдение, не readiness. */
  readonly control: (
    action: UserServiceAction,
    config: ServiceConfiguration,
    context: UserServiceContext,
    installed: boolean,
  ) => Promise<NativeServiceStatus>;
  /* Регистрирует/удаляет Server; ожидание готовности и окончательного lease остаётся снаружи. */
  readonly register: (
    action: "enable" | "disable",
    config: ServiceConfiguration,
    context: UserServiceContext,
    installed: boolean,
  ) => Promise<void>;
}
