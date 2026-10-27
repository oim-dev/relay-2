/** Параметры визуальной области. */
export type ReleaseCatalogProps = {
  /** Адрес проекта. */
  basePath: string;
  /** Начало создания релиза. */
  onCreate: () => void;
};
