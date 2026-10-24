/**
 * Атомарно опубликованные PID трёх реально запущенных уровней fixture.
 */
export interface NativeTreeReady {
  /* Непосредственный процесс команды или намеренно неисправного helper. */
  readonly parent: number;
  /* Detached-потомок первого уровня с унаследованными pipes. */
  readonly branch: number;
  /* Вложенный detached-потомок, также удерживающий stdout/stderr. */
  readonly leaf: number;
}
