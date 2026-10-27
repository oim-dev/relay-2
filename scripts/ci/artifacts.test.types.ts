import type { ArtifactContext } from "./artifacts.types";

/**
 * Изолированный checkout fixture; удаляется владельцем после теста, включая отказ.
 */
export interface ArtifactFixture {
  /* Контекст синтетического коммита; пользовательское окружение не меняется. */
  readonly context: ArtifactContext;
  /* Разрешённый каталог загрузок внутри .artifacts fixture. */
  readonly downloads: string;
  /* ID фактического поддержанного хоста для native pack/restore. */
  readonly target: string;
  /* Относительное имя нативного файла CLI с расширением текущего хоста. */
  readonly cliBinary: string;
}
