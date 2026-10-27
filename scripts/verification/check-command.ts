import { componentTasks, repositoryTasks } from "./catalog";

/**
 * Формирует единственный полный Turbo-запуск. dependencies-successful продолжает независимые
 * проверки и блокирует потребителей неуспешной сборки; always мог бы использовать старый dist.
 */
export function checkCommand(concurrency: number): readonly string[] {
  return [
    process.execPath,
    "x",
    "--no-install",
    "turbo",
    "run",
    ...componentTasks,
    ...repositoryTasks.map((task) => `//#${task}`),
    `--concurrency=${concurrency}`,
    "--continue=dependencies-successful",
    "--ui=stream",
    "--log-order=stream",
  ];
}
