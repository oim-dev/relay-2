/**
 * Рабочие бюджеты конечных функциональных маршрутов с одной-двумя независимыми репликами.
 * Включают fresh helper, подготовку SQLite/Git, все действия и assertions; одинаковы для всех ОС.
 * Это границы обнаружения зависания всего маршрута, не SLA и не лимит одного engine.run().
 * По истечении fixture отменяет работу; watchdog Bun отдельно оставляет GIT_FIXTURE_DRAIN_MS.
 */
export const gitFixtureDeadlines = {
  /* Настройка и несколько последовательных обменов, включая проверку history/layout и no-echo. */
  exchange: 30_000,
  /* Обход нескольких bounded окон с новыми owners либо non-FF, потерей ответа и recovery. */
  boundedRecovery: 45_000,
  /* Три аварийных actor, четвёртый recovery, затем доставка второй реплике и циклы no-echo. */
  crashRecovery: 60_000,
} as const;
