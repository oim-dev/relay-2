import { repository } from "./verification/catalog";
import { checkConcurrency } from "./verification/check-options";
import { checkCommand } from "./verification/check-command";
import { verifyEnvironment } from "./verification/environment";

/**
 * Запускает весь обычный CI-контур хоста одним Turbo DAG. Независимые задачи продолжаются
 * после отказа, зависимые от неуспешной сборки не запускаются на старом dist.
 * Вывод остаётся в терминале; собственных файлов отчёта/check-артефактов нет.
 */
async function check(): Promise<number> {
  const concurrency = checkConcurrency(process.argv.slice(2));
  await verifyEnvironment();
  const install = Bun.spawn([process.execPath, "install", "--frozen-lockfile"], {
    cwd: repository,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const installed = await install.exited;
  if (installed !== 0) {
    return installed;
  }
  const child = Bun.spawn([...checkCommand(concurrency)], {
    cwd: repository,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}

try {
  process.exitCode = await check();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
