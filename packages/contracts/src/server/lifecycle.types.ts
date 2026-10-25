/**
 * Стабильный код и пояснение отказа локального lifecycle, без приватных capabilities.
 */
export interface ServerLifecycleError {
  /* Машинный код причины отказа. */
  readonly code: string;
  /* Пояснение для пользователя; не используется для программного ветвления. */
  readonly message: string;
}

/**
 * Выбранная область одного HTTP-сервера; пути локальны и не являются HTTP-адресами.
 */
export interface ServerScope {
  /* Весь workspace либо один выбранный проект. */
  readonly kind: "project" | "workspace";
  /* Физический абсолютный путь исходной конфигурации. */
  readonly configPath: string;
  /* Имя регистрации при явном выборе проекта из workspace; иначе null. */
  readonly project: string | null;
}

/**
 * Наблюдение одной регистрации проекта без потери недоступных элементов.
 */
export interface ServerProjectStatus {
  /* Постоянный ID проверенной БД; null, если проект не удалось открыть. */
  readonly id: string | null;
  /* Имя регистрации workspace либо предметное имя локального проекта. */
  readonly name: string;
  /* Канонический slug проекта; null при недоступной базе. */
  readonly slug: string | null;
  /* Физический каталог проекта либо исходный недоступный путь. */
  readonly path: string;
  /* Возможность обслуживать этот проект на момент публикации health. */
  readonly available: boolean;
  /* Причина недоступности; отсутствует у доступного проекта. */
  readonly error?: ServerLifecycleError;
}

/**
 * Публичное наблюдение процесса; секрет control capability никогда не входит в этот DTO.
 */
export interface ServerInstanceStatus {
  /* UUID независимой регистрации; сохраняется при явном restart. */
  readonly instanceId: string;
  /* UUID конкретного запуска; null до первой регистрации процесса. */
  readonly bootId: string | null;
  /* ready подтверждён health; stale — запись без живого владельца; unresponsive — занятый lease без health. */
  readonly state: "ready" | "stopped" | "stale" | "unresponsive" | "incompatible" | "invalid";
  /* PID наблюдённого процесса, не доказательство живости и не разрешение kill. */
  readonly pid: number | null;
  /* Проверенный HTTP URL интерфейса либо последнее известное значение. */
  readonly url: string | null;
  /* Версия запуска либо launch до запуска; null при повреждённой регистрации. */
  readonly version: string | null;
  /* Владелец процесса; null означает повреждённую регистрацию с неизвестным владельцем. */
  readonly mode: "service" | "foreground" | null;
  /* Выбранная область сервера; null только у повреждённой записи. */
  readonly scope: ServerScope | null;
  /* Регистрации из ready health; при другом state состав неизвестен и массив пуст. */
  readonly projects: readonly ServerProjectStatus[];
  /* Время запуска ISO 8601; null до регистрации. */
  readonly startedAt: string | null;
  /* Диагностика повреждённого реестра или несовместимого health. */
  readonly error?: ServerLifecycleError;
}

/**
 * Список серверов одного RELAY_HOME; счётчики основаны на ответах, а не PID-файлах.
 */
export interface ServerInstanceList {
  /* Версия DTO управления сервером. */
  readonly version: 1;
  /* Физический корень локального реестра. */
  readonly home: string;
  /* Число экземпляров с подтверждённым ready. */
  readonly running: number;
  /* Число сохранённых регистраций, включая остановленные и повреждённые. */
  readonly registered: number;
  /* Независимые наблюдения, упорядоченные по instanceId. */
  readonly items: readonly ServerInstanceStatus[];
}
