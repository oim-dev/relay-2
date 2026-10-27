import type { Release } from "domains/releases";

/** Параметры визуальной области. */
export type ReleaseContentProps = {
  /** Самостоятельный релиз. */
  release: Release;
  /** Корень адресов проекта. */
  basePath: string;
  /** Открыть редактор состава релиза. */
  onEdit: () => void;
};
