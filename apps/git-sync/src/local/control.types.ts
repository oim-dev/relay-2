import type { GitSyncResponse, GitSyncControlRequest } from "@relay/contracts";

/**
 * Приватная capability локального control endpoint; файл имеет права 0600.
 */
export interface ControlEndpoint {
  /* Версия протокола готовности и управления. */
  readonly version: 1;
  /* Версия согласованного компонента, проверяемая независимо от PID. */
  readonly release: string;
  /* worker постоянен, request владеет ручным циклом, supervisor обслуживает home. */
  readonly kind: "worker" | "supervisor" | "request";
  /* Физическая идентичность базы либо home, не имя workspace. */
  readonly identity: string;
  /* Случайный ID конкретного запуска. */
  readonly instance: string;
  /* PID для диагностики; владение и отзывчивость не определяются по нему. */
  readonly pid: number;
  /* Случайный порт исключительно 127.0.0.1. */
  readonly port: number;
  /* Случайный bearer token, не передаваемый в argv или Git. */
  readonly capability: string;
  /* Время готовности ISO, не время spawn. */
  readonly startedAt: string;
  /* Instance владеющего supervisor; отсутствует у foreground/request и у самого supervisor. */
  readonly supervisorInstance?: string;
}

/**
 * Аутентифицированная команда уже выбранному локальному процессу.
 */
export type ControlRequest = GitSyncControlRequest;

/**
 * Владелец сервера локального управления; close удаляет только свой endpoint.
 */
export interface ControlOwner {
  /* Опубликованная проверяемая идентичность готового процесса. */
  readonly endpoint: ControlEndpoint;
  /* Закрывает сервер и атомарно снимает только собственную регистрацию готовности. */
  close(): Promise<void>;
}

/**
 * Ответ локального probe; null означает отсутствие подтверждённой отзывчивости.
 */
export type ControlResult = GitSyncResponse | null;
