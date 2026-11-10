import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Проверяет наличие Git-контекста проекта без процессов; содержимое .git затем проверяет транспорт.
 * Поддерживает обычный checkout и .git-файл linked worktree в корне проекта.
 * Родительский репозиторий не подхватывается: вложенный самостоятельный проект имеет свою область.
 */
export function hasProjectGit(directory: string): boolean {
  return existsSync(join(resolve(directory), ".git"));
}
