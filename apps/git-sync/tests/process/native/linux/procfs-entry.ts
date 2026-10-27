import { mock } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";

const nativeFs = { ...fs };
const nativeKill = process.kill;
const root = process.argv[2];
if (!root) {
  throw new Error("Не указан каталог барьера Linux procfs");
}
const armed = join(root, "procfs-arm.json");
const observed = join(root, "procfs-omitted.json");
let adoptedBranch: number | undefined;
let scans = 0;
const reads = new Map<string, number>();

/**
 * Читает настоящее родство, независимо от подменённого списка детей guardian.
 */
function branchParent(pid: number): number {
  const stat = nativeFs.readFileSync(`/proc/${pid}/stat`, "utf8");
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
}

/**
 * После настоящего SIGKILL группы ждёт усыновление branch ядром, прежде чем открыть fault-barrier.
 * Сигналы и усыновление не подменяются; ограниченное ожидание лишь задаёт порядок событий.
 */
function killWithAdoptionBarrier(
  pid: number,
  signal?: NodeJS.Signals | number,
): ReturnType<typeof process.kill> {
  const result = nativeKill(pid, signal);
  if (signal !== "SIGKILL" || pid >= 0 || adoptedBranch || !nativeFs.existsSync(armed)) {
    return result;
  }
  const value: unknown = JSON.parse(nativeFs.readFileSync(armed, "utf8"));
  if (
    value === null ||
    typeof value !== "object" ||
    !("anchor" in value) ||
    value.anchor !== -pid ||
    value.anchor === process.pid ||
    !("branch" in value) ||
    typeof value.branch !== "number"
  ) {
    return result;
  }
  const deadline = performance.now() + 1000;
  while (branchParent(value.branch) !== process.pid) {
    if (performance.now() >= deadline) {
      throw new Error("Ядро не усыновило detached branch до procfs fault-barrier");
    }
    Bun.sleepSync(1);
  }
  adoptedBranch = value.branch;
  return result;
}

/**
 * Имитирует документированный пропуск живых детей procfs при конкурентном exit.
 * Два обхода покрывают основной список и прежнее повторное подтверждение пустоты.
 */
function readWithOmittedChildren(
  path: fs.PathOrFileDescriptor,
  options?: Parameters<typeof fs.readFileSync>[1],
): string | Buffer {
  const value =
    options === undefined ? nativeFs.readFileSync(path) : nativeFs.readFileSync(path, options);
  if (
    adoptedBranch !== undefined &&
    typeof path === "string" &&
    /^\/proc\/self\/task\/\d+\/children$/u.test(path)
  ) {
    const count = (reads.get(path) ?? 0) + 1;
    reads.set(path, count);
    if (count <= 2) {
      if (count > scans) {
        scans = count;
        nativeFs.writeFileSync(
          `${observed}.tmp`,
          JSON.stringify({ scans, branch: adoptedBranch, parent: branchParent(adoptedBranch) }),
        );
        nativeFs.renameSync(`${observed}.tmp`, observed);
      }
      return typeof value === "string" ? "" : Buffer.alloc(0);
    }
  }
  return value;
}

// Подмена существует только в отдельном source-helper; production-протокол не получает test hooks.
mock.module("node:fs", () => ({
  ...nativeFs,
  readFileSync: readWithOmittedChildren,
}));
process.kill = killWithAdoptionBarrier;
const { runGuardianEntry } = await import("@relay/project-runtime");
process.exit(await runGuardianEntry());
