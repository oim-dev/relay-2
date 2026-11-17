import type { ProjectRegistration } from "../configuration/config.types";
import type { SynchronizationMode } from "@relay/storage";

/**
 * Независимая диагностика одного элемента глобальной сводки.
 */
export interface RelayStatusError {
  /* Стабильный код отказа; неожиданные I/O ошибки обозначаются STATUS_READ_FAILED. */
  readonly code: string;
  /* Пояснение причины без подмены недоступных данных пустыми значениями. */
  readonly message: string;
}

/**
 * Известная конфигурация текущего контекста или сохранённого серверного запуска.
 */
export interface RelayConfigurationStatus {
  /* Абсолютный путь; отсутствующий файл остаётся отдельной диагностикой. */
  readonly path: string;
  /* null означает, что файл прочитать или декодировать не удалось. */
  readonly kind: "project" | "workspace" | null;
  /* Постоянный ID только у проектной конфигурации. */
  readonly projectId: string | null;
  /* Разрешённый путь SQLite только у проектной конфигурации. */
  readonly databasePath: string | null;
  /* Имена регистраций workspace с абсолютными путями каталогов. */
  readonly registrations: readonly Readonly<ProjectRegistration>[];
  /* Причина недоступности конфигурации. */
  readonly error?: RelayStatusError;
}

/**
 * Краткое readonly-наблюдение одной локальной БД, без обхода её предметных сущностей.
 */
export interface RelayProjectStatus {
  /* Ожидаемый ID из home/projects/<ID> либо известной конфигурации. */
  readonly projectId: string;
  /* Имя карточки проекта; null при недоступной или несовместимой БД. */
  readonly name: string | null;
  /* Абсолютный путь SQLite, включая явные переопределения известных конфигов. */
  readonly databasePath: string;
  /* Связанные известные конфиги; пустой массив не означает отсутствие checkout на диске. */
  readonly configPaths: readonly string[];
  /* БД соответствует текущему выбранному проекту, а не только совпадающему ID. */
  readonly current: boolean;
  /* Схема, постоянный ID и имя проверены readonly-соединением. */
  readonly available: boolean;
  /* Сохранённый локальный режим обмена, без fetch и запуска CLI; null при отказе чтения. */
  readonly synchronization: SynchronizationMode | null;
  /* Отдельный отказ не препятствует чтению остальных проектов. */
  readonly error?: RelayStatusError;
}

/**
 * Диагностический контекст не ограничивает глобальное перечисление проектов.
 */
export interface RelayStatusContext {
  /* Абсолютный рабочий каталог вызова. */
  readonly cwd: string;
  /* Явный либо ближайший родительский конфиг; null вне проектов/workspace. */
  readonly configPath: string | null;
  /* Выбранная проектная конфигурация; null для workspace без --project или при ошибке. */
  readonly projectConfigPath: string | null;
  /* Независимая ошибка контекста не отменяет общую диагностику home. */
  readonly error?: RelayStatusError;
}

/**
 * Локальная сводка одного home. Не создаёт хранилища, не мигрирует БД и не запускает Git.
 */
export interface RelayHomeStatus {
  /* Физический абсолютный home; для отсутствующего каталога — разрешённый путь. */
  readonly home: string;
  /* Каталог стандартных проектных хранилищ. */
  readonly projectsPath: string;
  /* Каталог регистраций Server. */
  readonly serversPath: string;
  /* Весь известный набор БД этого home, независимо от cwd и --project. */
  readonly projects: readonly RelayProjectStatus[];
  /* Конфиги текущего контекста и серверов, включая связанные workspace-регистрации. */
  readonly configurations: readonly RelayConfigurationStatus[];
  /* Дополнительная подсветка текущего выбора. */
  readonly context: RelayStatusContext;
}

/**
 * Кандидат на readonly-проверку, объединённый по ожидаемому ID и физическому пути БД.
 */
export interface StatusProjectCandidate {
  /* Ожидаемый ID базы. */
  readonly projectId: string;
  /* Путь существующей или утраченной базы. */
  readonly databasePath: string;
  /* Известные конфиги, адресующие именно эту базу. */
  readonly configPaths: string[];
  /* Отказ канонизации пути; такой кандидат остаётся недоступным элементом сводки. */
  readonly error?: RelayStatusError;
}
