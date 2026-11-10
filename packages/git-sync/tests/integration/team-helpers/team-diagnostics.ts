import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SyncEngine } from "../../../src/sync/engine";
import type { GitProcessObservation } from "../../../src/transport/process-runtime.types";
import type {
  NativeGitCosts,
  TeamCost,
  TeamPhase,
  TeamPhaseMarker,
} from "./team-diagnostics.types";

const MAX_MARKERS = 128;
const MAX_TRACE_BYTES = 16 * 1024 * 1024;
const MAX_REPLICA_PHASES = 64;

/**
 * Определяет только имя операции; URL, argv payload и пути не попадают в агрегированные ключи.
 */
function gitOperation(argv: readonly string[]): string {
  let offset = 1;
  while (argv[offset] === "-c") {
    offset += 2;
  }
  return argv[offset] ?? "unknown";
}

/**
 * Обновляет ограниченную категорию. Git verbs/engine phases задаёт сам конечный сценарий.
 */
function add(
  costs: Record<string, TeamCost>,
  key: string,
  elapsedMs: number,
  nonZero = false,
): void {
  const item = (costs[key] ??= { count: 0, elapsedMs: 0, nonZero: 0 });
  item.count++;
  item.elapsedMs += elapsedMs;
  if (nonZero) {
    item.nonZero++;
  }
}

/**
 * Читает максимум 16 MiB временного trace2 после остановки Git, не загружая длинный log целиком.
 * Повреждённая последняя запись или усечённый prefix отражаются в сводке, не заменяют исходный отказ.
 */
function nativeCosts(path: string): NativeGitCosts | null {
  if (!existsSync(path)) {
    return null;
  }
  const file = openSync(path, "r");
  let totalBytes: number;
  let bytes: Buffer;
  try {
    totalBytes = fstatSync(file).size;
    const size = Math.min(totalBytes, MAX_TRACE_BYTES);
    bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const read = readSync(file, bytes, offset, size - offset, totalBytes - size + offset);
      if (read === 0) {
        break;
      }
      offset += read;
    }
    bytes = bytes.subarray(0, offset);
  } finally {
    closeSync(file);
  }
  const truncated = totalBytes > bytes.length;
  let text = bytes.toString("utf8");
  if (truncated) {
    text = text.slice(text.indexOf("\n") + 1);
  }
  const result: NativeGitCosts = {
    totalBytes,
    truncated,
    invalidLines: 0,
    starts: 0,
    exits: 0,
    operations: {},
  };
  const active = new Map<string, string>();
  for (const line of text.split("\n").filter(Boolean)) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      result.invalidLines++;
      continue;
    }
    if (
      typeof event !== "object" ||
      event === null ||
      !("sid" in event) ||
      typeof event.sid !== "string" ||
      event.sid.includes("/") ||
      !("event" in event)
    ) {
      continue;
    }
    if (
      event.event === "start" &&
      "argv" in event &&
      Array.isArray(event.argv) &&
      event.argv.every((arg: unknown) => typeof arg === "string")
    ) {
      result.starts++;
      active.set(event.sid, gitOperation(event.argv));
    } else if (
      event.event === "exit" &&
      "t_abs" in event &&
      typeof event.t_abs === "number" &&
      Number.isFinite(event.t_abs)
    ) {
      result.exits++;
      add(
        result.operations,
        active.get(event.sid) ?? "unknown-prefix",
        event.t_abs * 1000,
        "code" in event && event.code !== 0,
      );
      active.delete(event.sid);
    }
  }
  return result;
}

/**
 * Владеет только диагностикой finite fixture: агрегаты, 128 последних фаз и transient Git trace2.
 * Wrapper durations и native t_abs хранятся отдельно; отдельные actors входят лишь в native totals.
 */
export class TeamDiagnostics {
  /* Начало fixture, включая fresh helper build и создание независимых реплик. */
  private readonly started = performance.now();
  /* Временный raw trace удаляется вместе с fixture; публикуется только bounded summary на отказ. */
  readonly tracePath: string;
  /* Индекс участника для его каталога и private repository. */
  private readonly owners = new Map<string, number>();
  /* Последнее состояние не более чем у созданных участников конечного fixture. */
  private readonly phases = new Map<number, TeamPhase>();
  /* Ограниченный хвост phase markers. */
  private readonly markers: TeamPhaseMarker[] = [];
  /* Время завершённых фаз engine, не включающее ожидание idle. */
  private readonly phaseCosts: Record<string, TeamCost> = {};
  /* Guarded durations только Git-команд родительского процесса. */
  private readonly wrapperCosts: Record<string, TeamCost> = {};
  /* Длительность отдельных process actors не прибавляется к wrapper Git totals. */
  private readonly actorCosts: Record<string, TeamCost> = {};
  /* Время единственной ленивой подготовки fresh source helper, отдельно от wrapper durations. */
  private helperBuildMs: number | null = null;
  /* Фактически использованная команда helper; не пользовательский Git/SSH executable. */
  private helper: readonly string[] | null = null;
  /* Каталог временных материалов конкретного finite fixture. */
  private readonly root: string;
  /* Обычный каталог отчётов при запуске без CI_LOG_DIR. */
  private readonly artifacts: string;

  /**
   * Принимает принадлежащий fixture root без создания постоянных файлов в нём.
   */
  constructor(root: string, artifacts: string) {
    this.root = root;
    this.artifacts = artifacts;
    this.tracePath = join(root, "git-trace2.jsonl");
  }

  /**
   * Наблюдает production save, вызывая его ровно один раз и не меняя progress/решения engine.
   */
  engine(index: number, directory: string, engine: SyncEngine): SyncEngine {
    if (index >= MAX_REPLICA_PHASES) {
      return engine;
    }
    this.owners.set(directory, index);
    this.owners.set(join(directory, "repository.git"), index);
    const save = engine.save.bind(engine);
    engine.save = (): void => {
      this.phase(index, engine);
      save();
    };
    return engine;
  }

  /**
   * Сохраняет новый phase/attempt marker, ограничивая объём независимо от числа polling cycles.
   */
  private phase(index: number, engine: SyncEngine): void {
    const previous = this.phases.get(index);
    const { phase, attemptId } = engine.progress;
    if (previous?.phase === phase && previous.attemptId === attemptId) {
      return;
    }
    const startedMs = performance.now() - this.started;
    if (previous && previous.phase !== "idle") {
      add(this.phaseCosts, previous.phase, startedMs - previous.startedMs);
    }
    const value: TeamPhase = { phase, attemptId, startedMs };
    this.phases.set(index, value);
    this.markers.push({ replica: index, ...value });
    if (this.markers.length > MAX_MARKERS) {
      this.markers.shift();
    }
  }

  /**
   * Получает metadata настоящего runner, не заменяя его exit/stdout/stderr.
   */
  observe(observation: GitProcessObservation): void {
    const index = this.owners.get(observation.cwd) ?? -1;
    const phase = this.phases.get(index)?.phase ?? "setup";
    this.helper ??= observation.component;
    this.helperBuildMs ??= observation.helperPreparationMs;
    const isGit = observation.argv[0] === "git";
    const key = isGit ? `${phase}/${gitOperation(observation.argv)}` : `${index}/exchange-process`;
    add(
      isGit ? this.wrapperCosts : this.actorCosts,
      key,
      observation.elapsedMs,
      observation.exitCode !== 0 || observation.failure !== null,
    );
  }

  /**
   * Сохраняет finite-failure summary в собираемый CI_LOG_DIR или обычные артефакты fixture.
   * Никаких снимков проекта, командных payload и неограниченного raw trace в отчёте нет.
   */
  failure(error: unknown): string {
    const checkout = fileURLToPath(new URL("../../../../../", import.meta.url));
    const output = process.env.CI_LOG_DIR
      ? join(resolve(checkout, process.env.CI_LOG_DIR), "git-sync-team")
      : this.artifacts;
    mkdirSync(output, { recursive: true });
    const path = join(output, `failure-${basename(this.root)}.json`);
    writeFileSync(
      path,
      JSON.stringify(
        {
          version: 1,
          elapsedMs: performance.now() - this.started,
          environment: {
            platform: process.platform,
            arch: process.arch,
            bun: Bun.version,
            execPath: process.execPath,
            CI: process.env.CI ?? null,
          },
          helperBuildMs: this.helperBuildMs,
          helper: this.helper,
          failure:
            error instanceof Error
              ? {
                  name: error.name,
                  message: error.message.slice(0, 4096),
                  ...("code" in error && typeof error.code === "string"
                    ? { code: error.code }
                    : {}),
                }
              : { type: typeof error },
          replicas: new Set(this.owners.values()).size,
          replicaPhaseLimit: MAX_REPLICA_PHASES,
          latestPhases: [...this.phases].map(([replica, phase]) => ({ replica, ...phase })),
          markers: this.markers,
          phaseCosts: this.phaseCosts,
          gitWrapper: this.wrapperCosts,
          actors: this.actorCosts,
          gitNative: nativeCosts(this.tracePath),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    return path;
  }
}
