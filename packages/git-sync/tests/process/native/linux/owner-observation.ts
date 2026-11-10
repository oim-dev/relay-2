import { readFileSync, readdirSync } from "node:fs";
import type { ProcessIdentity } from "../../guardian-helpers/owner-observation.types";

/**
 * Читает текущий Linux stat без сигналов; starttime отделяет PID от конкретного процесса.
 */
export function processIdentity(pid: number): ProcessIdentity {
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
 * Находит bounded набор непосредственных детей своего owner, учитывая native threads Bun.
 * Это дополнительная диагностика, не доказательство cleanup: исчезнувшие потоки допустимы.
 */
export function ownerChildren(pid: number): readonly number[] {
  const pids = new Set<number>();
  try {
    for (const task of readdirSync(`/proc/${pid}/task`).slice(0, 32)) {
      try {
        const children = readFileSync(`/proc/${pid}/task/${task}/children`, "utf8");
        for (const child of children.trim().split(/\s+/u).slice(0, 16)) {
          const childPid = Number(child);
          if (Number.isSafeInteger(childPid) && childPid > 1) {
            pids.add(childPid);
          }
        }
      } catch {
        // Поток owner мог завершиться между списком и чтением; основное состояние пишется отдельно.
      }
    }
  } catch {
    // Owner мог завершиться до чтения procfs; отсутствие диагностики не подтверждает cleanup.
  }
  return [...pids];
}
