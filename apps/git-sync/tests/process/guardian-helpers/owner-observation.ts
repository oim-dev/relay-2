import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandOwner } from "./fixture.types";
import type {
  OwnerKillPhase,
  OwnerKillSnapshot,
  ProcessIdentity,
  ProcessObservation,
} from "./owner-observation.types";

const repository = fileURLToPath(new URL("../../../../..", import.meta.url));
const markerNames = [
  "tree.started",
  "branch.spawned",
  "branch.started",
  "leaf.spawned",
  "leaf.started",
  "leaf.ready",
  "branch.ready",
  "tree.ready",
  "branch.spawn-error",
  "leaf.spawn-error",
  "owner.json.result",
] as const;

/**
 * Извлекает только короткий native-код ошибки, без сообщения и потенциальных аргументов команды.
 */
function systemCode(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = String(error.code);
    if (/^[A-Z][A-Z0-9_]{0,40}$/u.test(code)) {
      return code;
    }
  }
  return "UNKNOWN";
}

/**
 * Читает один атомарный служебный маркер с ограничением размера; ошибка остаётся видимой в снимке.
 */
function markerValue(root: string, name: string): unknown {
  try {
    const value = readFileSync(join(root, name));
    if (value.length > 2048) {
      return { code: "MARKER_TOO_LARGE" };
    }
    return JSON.parse(value.toString("utf8"));
  } catch (error) {
    return { code: systemCode(error) };
  }
}

/**
 * Отделяет ранний результат/отказ runner от зависшей готовности actor; вывод команды не читается.
 */
function ownerResult(root: string): string | null {
  if (!existsSync(join(root, "owner.json.result"))) {
    return null;
  }
  const value = markerValue(root, "owner.json.result");
  if (value !== null && typeof value === "object") {
    if ("code" in value && typeof value.code === "number" && Number.isSafeInteger(value.code)) {
      return `code:${value.code}`;
    }
    if (
      "reason" in value &&
      typeof value.reason === "string" &&
      /^[a-z-]{1,40}$/u.test(value.reason)
    ) {
      return `reason:${value.reason}`;
    }
  }
  return "invalid-result";
}

/**
 * Читает текущий Linux stat без отправки сигналов; starttime отделяет PID от конкретного процесса.
 */
function processIdentity(pid: number): ProcessIdentity {
  const value = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = value.slice(value.lastIndexOf(")") + 2).split(" ");
  const [state, parent, group, session] = fields;
  const startTicks = fields[19];
  if (!state || !startTicks || !/^\d+$/u.test(startTicks)) {
    throw new Error("Некорректный stat процессной fixture");
  }
  return {
    pid,
    state,
    parent: Number(parent),
    group: Number(group),
    session: Number(session),
    startTicks,
  };
}

/**
 * Сохраняет идентичность либо причину отсутствия PID. Чтение не объявляет cleanup успешным.
 */
function processObservation(pid: number, identities: Map<number, string>): ProcessObservation {
  let current: ProcessIdentity | null = null;
  let errorCode: string | null = null;
  if (process.platform === "linux") {
    try {
      current = processIdentity(pid);
      if (!identities.has(pid)) {
        identities.set(pid, current.startTicks);
      }
    } catch (error) {
      errorCode = systemCode(error);
    }
  }
  return { pid, expectedStartTicks: identities.get(pid) ?? null, current, errorCode };
}

/**
 * Добавляет только проверенный PID из собственной fixture; системный список процессов не сканируется.
 */
function addPid(pids: Set<number>, value: unknown): void {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 1) {
    pids.add(value);
  }
}

/**
 * Находит непосредственный helper owner до появления tree.ready, учитывая native threads Bun.
 */
function addOwnerChildren(pids: Set<number>, owner: CommandOwner): void {
  if (
    process.platform !== "linux" ||
    !owner.child.pid ||
    owner.child.exitCode !== null ||
    owner.child.signalCode !== null
  ) {
    return;
  }
  try {
    for (const task of readdirSync(`/proc/${owner.child.pid}/task`).slice(0, 32)) {
      try {
        const children = readFileSync(`/proc/${owner.child.pid}/task/${task}/children`, "utf8");
        for (const child of children.trim().split(/\s+/u).slice(0, 16)) {
          addPid(pids, Number(child));
        }
      } catch {
        // Поток owner мог завершиться между списком и чтением; это лишь дополнительная диагностика.
      }
    }
  } catch {
    // Основное состояние owner отдельно включается в снимок, даже если procfs уже исчез.
  }
}

/**
 * Наблюдает три границы owner-kill и до внешнего 5 s watchdog сохраняет фазовую диагностику.
 * Не меняет deadline/assertions и не останавливает процессы. При отказе снимок снимается до finally
 * вызывающего; stderr ограничен, env/argv/config не публикуются.
 */
export async function withOwnerObservation(
  root: string,
  owner: CommandOwner,
  operation: (phase: (value: OwnerKillPhase) => void) => Promise<void>,
): Promise<void> {
  const started = performance.now();
  const identities = new Map<number, string>();
  const pids = new Set<number>();
  const boundaries: OwnerKillSnapshot[] = [];
  let phase: OwnerKillPhase = "tree-ready";
  let stderr = Buffer.alloc(0);
  let ownerError: string | null = null;
  addPid(pids, owner.child.pid);
  /**
   * Читает известные роли и родство; не принимает наличие файла или PID за успешный барьер.
   */
  function snapshot(): OwnerKillSnapshot {
    const markers = Object.fromEntries(
      markerNames.map((name) => [name, existsSync(join(root, name))]),
    );
    const spawnErrors: string[] = [];
    for (const name of markerNames) {
      if (!markers[name] || name === "owner.json.result") {
        continue;
      }
      const value = markerValue(root, name);
      if (typeof value === "number") {
        addPid(pids, value);
      } else if (value !== null && typeof value === "object") {
        for (const [key, pid] of Object.entries(value)) {
          if (["pid", "parent", "command", "anchor", "branch", "leaf"].includes(key)) {
            addPid(pids, pid);
          }
        }
        if (name.endsWith(".spawn-error")) {
          spawnErrors.push(`${name}:${systemCode(value)}`);
        }
      }
    }
    addOwnerChildren(pids, owner);
    return {
      phase,
      elapsedMs: Math.round(performance.now() - started),
      ownerExitCode: owner.child.exitCode,
      ownerSignal: owner.child.signalCode,
      ownerResult: ownerResult(root),
      markers,
      spawnErrors,
      processes: [...pids].map((pid) => processObservation(pid, identities)),
    };
  }
  /**
   * Публикует ограниченный отчёт в загружаемый CI-каталог и process log до аварийной очистки.
   */
  function report(reason: "before-watchdog" | "failure"): void {
    const value = {
      reason,
      boundaries,
      current: snapshot(),
      ownerError,
      stderr: stderr.toString("utf8"),
    };
    const content = JSON.stringify(value);
    process.stderr.write(`Диагностика guardian owner-kill: ${content}\n`);
    const directory = process.env.CI_LOG_DIR
      ? resolve(repository, process.env.CI_LOG_DIR, "process-guardian")
      : join(
          repository,
          ".artifacts",
          new Date().toISOString().slice(0, 10),
          "git-sync-implementation",
          "guardian",
          "diagnostics",
        );
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `${basename(root)}.json`), content + "\n");
    } catch (error) {
      // Ошибка сохранения отчёта не заменяет первичную ошибку теста; снимок уже попал в process log.
      process.stderr.write(`Не сохранена диагностика guardian: ${systemCode(error)}\n`);
    }
  }
  /**
   * Сохраняет только первые 4 KiB stderr данного owner, пока его поток читается обычной fixture.
   */
  function collectStderr(chunk: Buffer): void {
    stderr = Buffer.concat([stderr, chunk.subarray(0, Math.max(0, 4096 - stderr.length))]);
  }
  owner.child.stderr?.on("data", collectStderr);
  void owner.exited.catch((error: unknown) => {
    ownerError = systemCode(error);
  });
  boundaries.push(snapshot());
  const timer = setTimeout(() => report("before-watchdog"), 4000);
  try {
    await operation((value) => {
      phase = value;
      boundaries.push(snapshot());
    });
  } catch (error) {
    report("failure");
    throw error;
  } finally {
    clearTimeout(timer);
    owner.child.stderr?.off("data", collectStderr);
  }
}
