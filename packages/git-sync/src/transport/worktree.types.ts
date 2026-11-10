/**
 * Полномочия проверки служебного worktree; обычная материализация не создаёт и не чинит связи.
 */
export interface WorktreeIdentityOptions {
  /* Разрешает repair уже проверенного собственного worktree после переноса каталога. */
  readonly repair?: boolean;
  /* Только что успешный worktree add даёт право создать маркер владельца в новом admin-dir. */
  readonly created?: boolean;
}
