/**
 * Опубликованный локальный адрес control-протокола Git Sync; capability не выводится пользователю.
 */
export interface GitSyncControlEndpoint {
  /* Версия local control-протокола. */
  readonly version: 1;
  /* Полный выпуск компонента, включая поколение control-протокола. */
  readonly release: string;
  /* Разделяет worker проекта и supervisor home. */
  readonly kind: "worker" | "supervisor";
  /* Физический абсолютный путь базы либо home. */
  readonly identity: string;
  /* Случайный ID конкретного запуска; сверяется в ответе health. */
  readonly instance: string;
  /* PID только для диагностики, не доказательство отзывчивости. */
  readonly pid: number;
  /* Порт исключительно loopback 127.0.0.1. */
  readonly port: number;
  /* Непубликуемый bearer token локального пользователя. */
  readonly capability: string;
  /* ISO-время публикации готовности после bind. */
  readonly startedAt: string;
}

/**
 * Наблюдаемость supervisor, независимая от текста/состояния native service manager.
 */
export interface GitSyncSupervisorStatus {
  /* stopped — endpoint отсутствует; unresponsive — endpoint не подтвердил готовность. */
  readonly actual: "running" | "stopped" | "unresponsive" | "incompatible";
  /* true только после ответа health с ожидаемыми версией, identity и instance. */
  readonly responsive: boolean;
  /* ID опубликованного запуска; null без endpoint. */
  readonly instance: string | null;
  /* Опубликованный полный выпуск; null без endpoint. */
  readonly release: string | null;
  /* PID для диагностики; никогда не используется как доказательство готовности. */
  readonly pid: number | null;
  /* Время проверенного ответа health; null при отсутствии подтверждения. */
  readonly heartbeat: string | null;
}

/**
 * Ограничения одной проверки или ожидания готовности supervisor.
 */
export interface SupervisorProbeOptions {
  /* Версия выпуска CLI, например 0.0.0; control release выводится общим правилом. */
  readonly version: string;
  /* Deadline в миллисекундах; по умолчанию 2 секунды probe и 10 секунд ожидания. */
  readonly timeoutMs?: number;
  /* Отмена пользователя; не превращается в ложное состояние stopped. */
  readonly signal?: AbortSignal;
  /* При ожидании native start прежний instance не подтверждает запуск новой службы. */
  readonly previousInstance?: string;
}
