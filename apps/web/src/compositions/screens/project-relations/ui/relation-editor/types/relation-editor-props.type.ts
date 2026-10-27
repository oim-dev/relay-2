/** Параметры формы добавления отношения. */
export type RelationEditorProps = {
  /** Проект записи. */
  projectId: string;
  /** Версия при открытии формы. */
  version: string;
  /** Предварительно выбранное начало отношения. */
  root: string | null;
  /** Действие после подтверждённой записи. */
  onSaved: () => void;
  /** Закрывает форму по явной отмене. */
  onCancel: () => void;
};
/** Пользовательский ввод, независимый от транспортных DTO. */
export type RelationFormValues = {
  /** Адрес начала. */
  from: string;
  /** Адрес конца. */
  to: string;
  /** Расширяемый тип отношения. */
  type: string;
  /** Пояснение в Markdown. */
  description: string;
};
