/** Каталог выбора корня исследования. */
export type EntityBrowserProps = {
  /** Изолированный проект. */
  projectId: string;
  /** Канонический адрес выбранной сущности. */
  selected: string | null;
  /** Открывает окружение записи. */
  onSelect: (address: string) => void;
};
