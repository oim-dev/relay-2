import type { ProcessResult } from "../../../src/transport/process.types";
import type { GitFiles } from "../../../src/transport/repository.types";
import { DataRepository } from "../../../src/transport/repository";
import type { PublicationAttempt } from "./team-fixture.types";

const BARRIER_DEADLINE_MS = 20_000;

/**
 * Барьер ровно двух готовых кандидатов: второй настоящий push следует после первого.
 * Оба кандидата уже построены на общем HEAD, поэтому второй обязан получить non-FF.
 */
export class TwoWriterBarrier {
  /* Готовность обоих участников, без зависимости от скорости Git или sleep. */
  private readonly ready = Promise.withResolvers<void>();
  /* Завершение первого настоящего push, после которого допускается второй. */
  private readonly firstPublished = Promise.withResolvers<void>();
  /* Пришедшие роли; повтор одной роли указывает на ошибку подготовки теста. */
  private readonly arrivals = new Set<"first" | "second">();
  /* Общая отмена fixture; ожидания не продолжают Git после deadline. */
  private readonly signal: AbortSignal;
  /* Короткий deadline барьера на случай отказа второго writer до входа. */
  private readonly deadline: ReturnType<typeof setTimeout>;
  /* Причина аварийного освобождения; null до отмены либо закрытия. */
  private failure: Error | null = null;

  /**
   * Привязывает ожидания к конечной отмене fixture; слушатель освобождается close().
   */
  constructor(signal: AbortSignal) {
    this.signal = signal;
    this.deadline = setTimeout(() => {
      this.failure = new Error("Второй writer не прошёл барьер до deadline");
      this.cancel();
    }, BARRIER_DEADLINE_MS);
    signal.addEventListener("abort", this.cancel, { once: true });
    if (signal.aborted) {
      this.cancel();
    }
  }

  /**
   * Отпускает ожидающие Promise при аварии; wait проверяет signal до запуска Git.
   */
  private readonly cancel = (): void => {
    this.failure ??= new Error("Двухсторонний барьер закрыт или отменён");
    this.ready.resolve();
    this.firstPublished.resolve();
  };

  /**
   * Удерживает первый push каждой роли до готовности второго кандидата.
   */
  async wait(role: "first" | "second"): Promise<void> {
    if (this.arrivals.has(role)) {
      throw new Error(`Повторный вход роли ${role} в двухсторонний барьер`);
    }
    this.arrivals.add(role);
    if (this.arrivals.size === 2) {
      this.ready.resolve();
    }
    await this.ready.promise;
    if (role === "second") {
      await this.firstPublished.promise;
    }
    if (this.failure !== null) {
      throw this.failure;
    }
    this.signal.throwIfAborted();
  }

  /**
   * Разрешает второму участнику попытку после фактического завершения первого push.
   */
  published(role: "first" | "second"): void {
    if (role === "first") {
      this.firstPublished.resolve();
    }
  }

  /**
   * Освобождает ожидающих и обработчик отмены, включая отказ одного из участников.
   */
  close(): void {
    clearTimeout(this.deadline);
    this.signal.removeEventListener("abort", this.cancel);
    this.cancel();
  }
}

/**
 * Настоящий Git-транспорт с наблюдением публикаций и одноразовыми fault injection.
 * Ни данные snapshot, ни результат merge, ни реальный исход push не подменяются.
 */
export class TeamRepository extends DataRepository {
  /* Наблюдаемые реальные попытки push в порядке их выполнения. */
  readonly publications: PublicationAttempt[] = [];
  /* Одноразовая потеря ответа только после фактически успешного push. */
  loseNextSuccessfulReply = false;
  /* Сколько успешных ответов было потеряно в этом конечном сценарии. */
  lostReplies = 0;
  /* HEAD последнего кандидата; фиксируется настоящим commit приложения. */
  private parent: string | null = null;
  /* Барьер применяется только к ближайшему push, retry проходит без него. */
  private gate: TwoWriterBarrier | null = null;
  /* Роль реплики в явно назначенной гонке. */
  private role: "first" | "second" = "first";

  /**
   * Назначает единственный барьер ближайшей публикации до запуска engine.run().
   */
  gateNextPush(barrier: TwoWriterBarrier, role: "first" | "second"): void {
    this.gate = barrier;
    this.role = role;
  }

  /**
   * Запоминает родительский HEAD, делегируя всю запись объектов production-транспорту.
   */
  override async commit(files: GitFiles, parent: string | null): Promise<string> {
    this.parent = parent;
    return super.commit(files, parent);
  }

  /**
   * Выполняет настоящий FF push; при назначенном сбое теряет только успешный ответ.
   */
  override async push(commit: string): Promise<ProcessResult> {
    const gate = this.gate;
    this.gate = null;
    await gate?.wait(this.role);
    let result: ProcessResult;
    try {
      result = await super.push(commit);
    } finally {
      gate?.published(this.role);
    }
    this.publications.push({
      commit,
      parent: this.parent,
      exitCode: result.exitCode,
      stdout: result.stdout.toString("utf8"),
    });
    if (result.exitCode === 0 && this.loseNextSuccessfulReply) {
      this.loseNextSuccessfulReply = false;
      this.lostReplies++;
      return { exitCode: 128, stdout: Buffer.alloc(0), stderr: Buffer.from("Утрачен ответ push") };
    }
    return result;
  }
}
