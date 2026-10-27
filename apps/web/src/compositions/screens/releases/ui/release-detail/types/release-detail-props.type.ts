import type { Release, ReleaseStatus } from "domains/releases";

/** Параметры визуальной области. */
export type ReleaseDetailProps = {
  /** Просматриваемый релиз. */
  release: Release;
  /** Адрес проекта. */
  basePath: string;
  /** Открыть редактор или явно предложить новый статус. */
  onEdit: (status?: ReleaseStatus) => void;
};
