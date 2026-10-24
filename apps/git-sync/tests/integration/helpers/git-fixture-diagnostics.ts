import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { GitProcessObservation } from "../../../src/transport/process-runtime.types";
import type { GitFixtureLimits } from "./git-fixture.types";
import type { GitFixtureCommand, GitFixturePhase } from "./git-fixture-diagnostics.types";

const MAX_PHASES = 64;
const MAX_COMMANDS = 128;

/**
 * Ограничивает фазовую диагностику одного fixture; не меняет Git, engine или их результаты.
 * Отчёт сохраняется до abort и после drain, поэтому watchdog не уничтожает последнюю фазу.
 * Duration runner не выдаётся за native Git time или доказательство производительности.
 */
export class GitFixtureDiagnostics {
  /* Начало включает fresh helper, bare origin и независимые SQLite/Git. */
  private readonly started = performance.now();
  /* Последние смысловые фазы, без неограниченного журнала. */
  private readonly phases: GitFixturePhase[] = [];
  /* Последние завершённые команды, без argv и содержимого проекта. */
  private readonly commands: GitFixtureCommand[] = [];
  /* Полное число команд, даже если старые наблюдения удалены из хвоста. */
  private commandCount = 0;
  /* Wrapper cost всех завершённых команд; не складывается с параллельным wall time. */
  private commandElapsedMs = 0;
  /* Единственная свежая подготовка source helper, отдельно от каждой команды. */
  private helperPreparationMs: number | null = null;
  /* Фаза исчерпания бюджета сохраняется и после последующих drain/closed markers. */
  private expiredPhase: GitFixturePhase | null = null;
  /* Путь за пределами удаляемого каталога fixture. */
  private readonly reportPath: string;
  /* Имя и исходный рабочий deadline сценария. */
  private readonly limits: GitFixtureLimits;

  /**
   * Выбирает собираемый CI_LOG_DIR либо артефакты текущего запуска; файл создаётся при save.
   */
  constructor(root: string, artifacts: string, limits: GitFixtureLimits) {
    this.limits = limits;
    const output = process.env.CI_LOG_DIR
      ? resolve(import.meta.dir, "../../../../..", process.env.CI_LOG_DIR, "git-sync-fixtures")
      : artifacts;
    this.reportPath = join(output, `${limits.name}-${basename(root)}.json`);
    this.phase("fixture/start");
  }

  /**
   * Закрывает прежнюю фазу и отмечает новую; имена и хвост имеют фиксированные границы.
   */
  phase(name: string): void {
    const now = performance.now() - this.started;
    const previous = this.phases.at(-1);
    if (previous) {
      previous.elapsedMs = now - previous.startedMs;
    }
    this.phases.push({ name: name.slice(0, 160), startedMs: now, elapsedMs: null });
    if (this.phases.length > MAX_PHASES) {
      this.phases.shift();
    }
  }

  /**
   * Измеряет техническую подготовку отдельно от окружающей смысловой фазы теста.
   */
  async preparation<T>(name: string, run: () => Promise<T>): Promise<T> {
    const previous = this.phases.at(-1)?.name ?? "scenario";
    this.phase(name);
    try {
      return await run();
    } finally {
      this.phase(previous);
    }
  }

  /**
   * Принимает metadata production runtime; сохраняет только имя Git-команды и конечный исход.
   */
  observe(value: GitProcessObservation): void {
    this.helperPreparationMs ??= value.helperPreparationMs;
    let offset = 1;
    while (value.argv[offset] === "-c") {
      offset += 2;
    }
    this.commandCount++;
    this.commandElapsedMs += value.elapsedMs;
    this.commands.push({
      phase: this.phases.at(-1)?.name ?? "unknown",
      command: value.argv[0] === "git" ? (value.argv[offset] ?? "unknown") : "process",
      elapsedMs: value.elapsedMs,
      exitCode: value.exitCode,
      failure: value.failure,
    });
    if (this.commands.length > MAX_COMMANDS) {
      this.commands.shift();
    }
  }

  /**
   * Сохраняет bounded snapshot; ошибка диагностической записи не подменяет исходный отказ теста.
   */
  save(status: "deadline" | "failed" | "completed", error?: unknown): void {
    try {
      if (status === "deadline") {
        const phase = this.phases.at(-1);
        this.expiredPhase = phase
          ? { ...phase, elapsedMs: performance.now() - this.started - phase.startedMs }
          : null;
      }
      mkdirSync(dirname(this.reportPath), { recursive: true });
      writeFileSync(
        this.reportPath,
        JSON.stringify(
          {
            version: 1,
            ...this.limits,
            status,
            platform: process.platform,
            bun: Bun.version,
            elapsedMs: performance.now() - this.started,
            helperPreparationMs: this.helperPreparationMs,
            commandCount: this.commandCount,
            commandElapsedMs: this.commandElapsedMs,
            expiredPhase: this.expiredPhase,
            phases: this.phases,
            commands: this.commands,
            failure:
              error instanceof Error
                ? { name: error.name, message: error.message.slice(0, 2048) }
                : null,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    } catch (failure) {
      console.error("Не удалось сохранить фазовую диагностику Git fixture:", failure);
    }
  }
}
