/**
 * Завершённая либо текущая смысловая фаза конечного Git fixture.
 */
export interface GitFixturePhase {
  /* Имя задаёт тест; пользовательские payload и argv не сохраняются. */
  readonly name: string;
  /* Смещение начала от открытия fixture, в миллисекундах. */
  readonly startedMs: number;
  /* Длительность до следующей фазы; null означает активную фазу. */
  elapsedMs: number | null;
}

/**
 * Bounded наблюдение завершённой guarded команды, отдельно от сборки source helper.
 */
export interface GitFixtureCommand {
  /* Смысловая фаза сценария в момент завершения команды. */
  readonly phase: string;
  /* Только Git verb либо process, без argv, URL и тел записей. */
  readonly command: string;
  /* Длительность production runner в миллисекундах, включая guardian, но без helper build. */
  readonly elapsedMs: number;
  /* Реальный exit либо null при инфраструктурном отказе. */
  readonly exitCode: number | null;
  /* Категория отказа runner; null при полученном результате команды. */
  readonly failure: string | null;
}
