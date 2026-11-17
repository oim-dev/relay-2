import type { ParentProcessProbe } from "../../parent-process/observation.types";

/**
 * Наблюдает исходное POSIX-родство через динамический getppid, предоставляемый process.ppid.
 * После смерти родителя ядро меняет родство на init/subreaper; повторное использование номера
 * PID не восстанавливает эту связь. Процесс не открывается и сигналы по PID не отправляются.
 */
export function capturePosixParent(parentPid: number): ParentProcessProbe {
  return {
    /**
     * Сверяет живую связь текущего процесса с первоначальным родителем, а не существование номера PID.
     */
    isAlive: (): boolean => process.ppid === parentPid,
    /**
     * Наблюдение родства не удерживает нативных ресурсов.
     */
    dispose(): void {},
  };
}
