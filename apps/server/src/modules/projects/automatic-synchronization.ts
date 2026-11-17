import { automaticSynchronizationMessages as messages } from "./automatic-synchronization.messages";

/* Общий бюджет автоматических обменов одного Server; разные процессы координирует Runtime mutex. */
const MAX_AUTOMATIC_EXCHANGES = 2;

/**
 * Владеет фоновыми попытками Server: одна queued/running задача на проект, ограниченная
 * параллельность и обязательное завершение при close. HTTP не ожидает этих Promise.
 * Расписание остаётся durable в SQLite; класс объединяет сигналы активности, не создавая daemon.
 */
export class AutomaticSynchronization {
  /* Очередь конечных попыток в порядке первого обращения проекта. */
  private readonly queued = new Map<string, () => Promise<void>>();
  /* Все queued/running projectId, исключающие повторный spawn из соседних HTTP-запросов. */
  private readonly scheduled = new Set<string>();
  /* Запущенные Promise всегда имеют обработчик отказа и принадлежат close. */
  private readonly active = new Set<Promise<void>>();
  /* Неожиданные отказы канала диагностики должны быть видны владельцу при закрытии. */
  private readonly failures: unknown[] = [];
  /* Запрещает новые попытки и запуск оставшейся очереди после начала HTTP shutdown. */
  private stopped = false;
  /* Идемпотентное ожидание принятых задач. */
  private completion: Promise<void> | undefined;

  /**
   * Получает независимый канал диагностики обмена; его ошибка не меняет уже отправленный HTTP-ответ.
   */
  constructor(
    /* Сообщает исход одной фоновой попытки; отсутствие UI-уведомления не отменяет локальную запись. */
    private readonly report: (error: unknown) => void | Promise<void>,
  ) {}

  /**
   * Объединяет повторные сигналы одного проекта. Тяжёлая работа начинается после текущего стека.
   * operation повторно проверяет scope/mode/debounce перед процессным вызовом.
   */
  request(projectId: string, operation: () => Promise<void>): void {
    if (this.stopped || this.scheduled.has(projectId)) {
      return;
    }
    this.scheduled.add(projectId);
    this.queued.set(projectId, operation);
    queueMicrotask(() => this.startAvailable());
  }

  /**
   * Заполняет только свободные слоты; settlement запускает следующий проект без таймера polling.
   */
  private startAvailable(): void {
    while (!this.stopped && this.active.size < MAX_AUTOMATIC_EXCHANGES) {
      const next = this.queued.entries().next().value;
      if (next === undefined) {
        return;
      }
      const [projectId, operation] = next;
      this.queued.delete(projectId);
      const task = Promise.resolve()
        .then(() => {
          if (!this.stopped) {
            return operation();
          }
        })
        .catch((error) => this.report(error))
        .catch((error) => {
          this.failures.push(error);
        })
        .finally(() => {
          this.active.delete(task);
          this.scheduled.delete(projectId);
          this.startAvailable();
        });
      this.active.add(task);
    }
  }

  /**
   * Снимает ожидающие попытки. Активные Git-процессы принадлежат существующему grace/abort Runtime.
   */
  stop(): void {
    this.stopped = true;
    for (const projectId of this.queued.keys()) {
      this.scheduled.delete(projectId);
    }
    this.queued.clear();
  }

  /**
   * Ожидает активный обмен и диагностику; неожиданные ошибки reporter не выдаются за успешную очистку.
   */
  close(): Promise<void> {
    this.stop();
    return (this.completion ??= Promise.all([...this.active]).then(() => {
      if (this.failures.length > 0) {
        throw new AggregateError(this.failures, messages.reportingFailed);
      }
    }));
  }
}
