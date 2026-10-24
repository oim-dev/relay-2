import type { GuardedCommandResult } from "@relay/project-runtime";

/**
 * Lifetime одного свежего source helper; native containment принадлежит Runtime guardian.
 */
export interface GitProcessRuntime {
  /* Ленивая единственная подготовка доверенного helper текущего scope. */
  readonly component: () => Promise<readonly string[]>;
  /* Длительность единственной подготовки helper; не прибавляется к каждому wrapper duration. */
  preparationMs: number;
  /* Начатые команды, чьё завершение предшествует удалению helper. */
  readonly pending: Set<Promise<GuardedCommandResult>>;
  /* Необязательное наблюдение завершённых процессов без stdout, stdin и payload снимков. */
  readonly observe?: (observation: GitProcessObservation) => void;
  /* Завершённый caller больше не может запускать команды через унаследованный async context. */
  closed: boolean;
}

/**
 * Стоимость одного реального guarded запуска; это wrapper duration, а не внутреннее время Git.
 */
export interface GitProcessObservation {
  /* Фактическая команда target, включая executable; секреты не следует писать в публичные логи. */
  readonly argv: readonly string[];
  /* Каталог target для связи с конкретным owner; глобальный cwd не меняется. */
  readonly cwd: string;
  /* Команда доверенного helper, фактически выбранная для этого запуска. */
  readonly component: readonly string[];
  /* Длительность подготовки helper всего scope; одинаковая metadata у его команд. */
  readonly helperPreparationMs: number;
  /* Полная длительность runner в миллисекундах, включая startup, IPC и cleanup. */
  readonly elapsedMs: number;
  /* Exit target либо null при инфраструктурном отказе до подтверждённого результата. */
  readonly exitCode: number | null;
  /* Причина инфраструктурного отказа либо null при полученном exit target. */
  readonly failure: string | null;
}
