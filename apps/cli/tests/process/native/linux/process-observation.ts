import { readFileSync } from "node:fs";
import { setTimeout as pause } from "node:timers/promises";

/**
 * Ждёт наблюдаемое завершение Linux-процесса до deadline, не вызывая production cleanup.
 * Zombie уже не выполняется; reap принадлежит init. Ошибка чтения, кроме ENOENT, видна тесту.
 */
export async function waitForFixtureExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")) {
        return;
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    await pause(10);
  }
  throw new Error(`Fixture supervisor ${pid} пережил EOF своего stdin lease`);
}
