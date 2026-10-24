/**
 * Готовность скомпилированного fixture-компонента, подтверждаемая его независимым loopback endpoint.
 */
export interface GitSyncFixtureReady {
  /* PID компонента, отдельный от PID CLI-прокси. */
  readonly pid: number;
  /* Порт только 127.0.0.1 для событийного барьера перед SIGKILL прокси. */
  readonly port: number;
}
