import type { KnowledgeSnapshot } from "domains/knowledge";
import type { DocumentSectionChange } from "domains/documents";
/**
 * Управление каталогом разделов под версией проекта.
 */
export interface SectionEditorProps {
  /* Исходный проект-владелец разделов и его aggregateVersion. */
  readonly source: KnowledgeSnapshot;
  /* Закрытие с сохранением черновика. */
  readonly onClose: () => void;
  /* Обновление библиотеки после известного успеха. */
  readonly onSaved: () => void;
}

/**
 * Действия каталога разделов из текущего Core.
 */
export interface SectionValues {
  /* Выбранное действие, определяющее отправляемые поля. */
  action: DocumentSectionChange["action"];
  /* ID существующего раздела; null до выбора. */
  id: string | null;
  /* Название при создании или переименовании. */
  name: string;
  /* ID следующего раздела; null перемещает в конец. */
  before: string | null;
}

/**
 * Ввод и версия проекта одного редактирования разделов.
 */
export interface SectionDraft {
  /* Первоначальное versioned read проекта. */
  readonly source: KnowledgeSnapshot;
  /* Пользовательские параметры одного действия. */
  readonly values: SectionValues;
}
