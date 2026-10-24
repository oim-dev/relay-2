/**
 * Место в FIFO принадлежит живому соединению, а не endpoint-файлу или PID.
 */
export interface NetworkLease {
  /* Случайный ID соединения. */
  readonly id: string;
  /* Уже отправлены queued/granted события этого writer. */
  readonly stream: ReadableStreamDefaultController<Uint8Array>;
  /* Корреляция обращения. */
  readonly requestId: string;
  /* True только пока соединение занимает активный слот. */
  granted: boolean;
  /* Отмена server request/EOF. */
  readonly signal: AbortSignal;
  /* Listener снимается при любом завершении. */
  readonly abort: () => void;
}
