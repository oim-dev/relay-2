import type { Release } from "domains/releases";

/** Параметры визуальной области. */
export type ReleaseCardProps = {
  /** Самостоятельная запись выпуска. */
  release: Release;
  /** Адрес проекта. */
  basePath: string;
};
