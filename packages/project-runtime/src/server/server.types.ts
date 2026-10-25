import type {
  ServerInstanceList,
  ServerInstanceStatus,
  ServerProjectStatus,
  ServerScope,
} from "@relay/contracts";
import type { RuntimeOptions } from "../configuration/runtime-options.types";
import type { GitSyncEnvironment } from "../git-sync/client.types";
import type { ProjectLocation } from "../project/location.types";

/**
 * Доступная регистрация с проверенным расположением; null сохраняет независимый отказ проекта.
 */
export interface ServerProjectLocation extends ServerProjectStatus {
  /* Проверенное расположение БД; вызывающий открывает собственное соединение. */
  readonly location: ProjectLocation | null;
  /* dev/inode/birthtime физического файла; null при недоступности. */
  readonly identity: string | null;
}

/**
 * Разрешённая область сервера без удержания проектных соединений.
 */
export interface ResolvedServerScope {
  /* Источник выбора проектов. */
  readonly scope: ServerScope;
  /* Все регистрации в порядке конфигурации. */
  readonly projects: readonly ServerProjectLocation[];
}

/**
 * Сохранённый запуск независимого сервера; не содержит control capability и окружения пользователя.
 */
export interface ServerLaunch {
  /* Версия локального launch-формата. */
  readonly protocol: 1;
  /* UUID регистрации, неизменный при restart. */
  readonly instanceId: string;
  /* Согласованная версия поставки. */
  readonly version: string;
  /* Абсолютный физический RELAY_HOME. */
  readonly home: string;
  /* Абсолютный путь этого launch-манифеста. */
  readonly path: string;
  /* Явные абсолютные параметры выбора проекта. */
  readonly options: RuntimeOptions;
  /* Область на момент создания; при запуске проекты проверяются заново. */
  readonly scope: ServerScope;
  /* Явный автор Web по умолчанию; при отсутствии ввода createServerLaunch сохраняет «web». */
  readonly actor: string;
  /* Порт HTTP SPA/API; 0 поручает ОС выбрать свободный порт. */
  readonly port: number;
  /* Владелец lifetime процесса. */
  readonly mode: "service" | "foreground";
}

/**
 * Пользовательские параметры нового запуска.
 */
export interface ServerStartInput {
  /* Автор Web; отсутствие нормализуется в «web» при сохранении launch. */
  readonly actor?: string;
  /* TCP-порт; по умолчанию 0. */
  readonly port?: number;
}

/**
 * Параметры публикации launch, разделённые с клиентским вводом.
 */
export interface ServerLaunchInput extends ServerStartInput {
  /* Точная версия компонента. */
  readonly version: string;
  /* Владение процессом определяется явным run либо native start. */
  readonly mode: "service" | "foreground";
}

/**
 * Нативная среда серверного клиента; использует общий guarded runner и native file store.
 */
export type ServerEnvironment = Omit<GitSyncEnvironment, "supervisorProbe" | "supervisorLockProbe">;

/**
 * Локальный процессный порт CLI; ни один метод не меняет глобальные cwd/env.
 */
export interface ServerClient {
  /* Создаёт независимую native-службу и ожидает готовность. */
  readonly start: (
    options: RuntimeOptions,
    input: ServerStartInput,
  ) => Promise<ServerInstanceStatus>;
  /* Удерживает foreground до завершения; guardian владеет деревом. */
  readonly run: (options: RuntimeOptions, input: ServerStartInput) => Promise<void>;
  /* Читает реестр home и проверяет health всех записей либо одного UUID. */
  readonly list: (options: RuntimeOptions, instanceId?: string) => Promise<ServerInstanceList>;
  /* Останавливает выбранный UUID; никогда не использует сохранённый PID как kill target. */
  readonly stop: (options: RuntimeOptions, instanceId: string) => Promise<ServerInstanceStatus>;
  /* Перезапускает сохранённый контекст как native-службу с новым bootId/nonce. */
  readonly restart: (options: RuntimeOptions, instanceId: string) => Promise<ServerInstanceStatus>;
  /* Открывает URL единственного выбранного ready экземпляра системным браузером. */
  readonly open: (options: RuntimeOptions, instanceId?: string) => Promise<ServerInstanceStatus>;
}

/**
 * Готовность приложения, публикуемая после bind HTTP и подготовки проектного контекста.
 */
export interface ServerReadyInput {
  /* URL SPA/API только на IPv4 loopback. */
  readonly url: string;
  /* Наблюдения проектов; функция перечитывает доступность для каждого health. */
  readonly projects: readonly ServerProjectStatus[] | (() => readonly ServerProjectStatus[]);
  /* Синхронно запрашивает shutdown приложения; cleanup выполняется вызывающим в finally. */
  readonly onStop: () => void;
}

/**
 * Удерживаемая регистрация процесса. close вызывается после остановки HTTP и закрытия его ресурсов.
 */
export interface ServerRegistration {
  /* UUID конкретного процесса, отличный от стабильного instanceId. */
  readonly bootId: string;
  /* Публикует loopback control ровно один раз после готовности приложения. */
  readonly ready: (input: ServerReadyInput) => void;
  /* Прекращает ready health, сохраняя endpoint и lifetime mutex до завершения cleanup. */
  readonly draining: () => void;
  /* Удаляет только свой endpoint и освобождает lifetime mutex; повторный close безопасен. */
  readonly close: () => void;
}

/**
 * Приватный endpoint; nonce никогда не возвращается в пользовательском list/status.
 */
export interface ServerEndpoint {
  /* Версия control-протокола. */
  readonly protocol: 1;
  /* Стабильный UUID регистрации. */
  readonly instanceId: string;
  /* UUID конкретного boot. */
  readonly bootId: string;
  /* 256-битная случайная capability в hex. */
  readonly nonce: string;
  /* Порт отдельного IPv4 loopback control. */
  readonly controlPort: number;
  /* PID наблюдения; не используется для сигналов. */
  readonly pid: number;
  /* Точная версия поставки. */
  readonly version: string;
  /* Физический корень реестра. */
  readonly home: string;
  /* HTTP URL приложения. */
  readonly url: string;
  /* Время запуска ISO 8601. */
  readonly startedAt: string;
}
