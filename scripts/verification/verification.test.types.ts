/**
 * Наблюдаемая задача настоящего Turbo dry-run, без исполнения её команды.
 */
export interface PlannedTask {
  /* Полный workspace#task либо //#root-task. */
  readonly id: string;
  /* Непосредственные зависимости графа. */
  readonly dependencies: readonly string[];
  /* Фактический package script, а не строка ожидаемого результата. */
  readonly command: string;
  /* Разрешает ли эффективная конфигурация Turbo пропустить исполнение по кешу. */
  readonly cache: boolean;
}

/**
 * Исходы внешних инструментов для проверки порядка действий процессного входа check.
 */
export interface CheckEntryCase {
  /* Наблюдаемый сценарий остановки или успешного завершения. */
  readonly name: string;
  /* Ошибка preflight; null оставляет требуемые версии Node и доступный Git. */
  readonly preflightFailure: "node" | "git" | null;
  /* Код завершения frozen install, если эта стадия была вызвана. */
  readonly installExit: number;
  /* Код единственного Turbo-запуска, если install разрешил его. */
  readonly turboExit: number;
  /* Ожидаемый код самого check, а не одного из подменённых инструментов. */
  readonly expectedExit: number;
  /* Полный порядок разрешённых внешних вызовов; поздние стадии после отказа отсутствуют. */
  readonly expectedSteps: readonly string[];
}

/**
 * Завершённый изолированный Bun-процесс, исполнивший настоящий check.ts с подменой инструментов.
 */
export interface CheckEntryProbe {
  /* Код выхода процессного входа check. */
  readonly code: number;
  /* Диагностика check без нормализации. */
  readonly stderr: string;
  /* Внешняя JSON-трасса инструментов; форму и значения проверяет сам сценарий. */
  readonly trace: unknown;
}
