/** Центральное окно задачи; URL принадлежит вызывающему экрану. */
export type TaskModalProps = {
  projectId: string;
  reference: string;
  startEditing: boolean;
  onClose: () => void;
  onOpen: (id: string, boardSlug?: string) => void;
};
