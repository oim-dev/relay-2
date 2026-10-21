/**
 * Захваченные потоки одного внутрипроцессного вызова CLI.
 */
export interface CliInvocation {
  /* Код завершения, возвращённый runCli. */
  readonly code: number;

  /* Полный stdout без преобразования и обрезки. */
  readonly stdout: string;

  /* Полный stderr без преобразования и обрезки. */
  readonly stderr: string;
}
