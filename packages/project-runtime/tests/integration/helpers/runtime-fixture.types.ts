import type { Subprocess } from "bun";

/**
 * Минимальный контракт дочернего процесса, которым владеет файловый fixture.
 */
export type RuntimeChild = Pick<Subprocess, "kill" | "exited">;
