import type { CatalogKind, KnowledgeSnapshot, KnowledgeContentMap } from "domains/knowledge";

/**
 * Пользовательский ввод; скрытые поля никогда не включаются в команду другого действия.
 */
export interface KnowledgeValues {
  /* Название карточки либо заголовок реализации. */
  name: string;
  /* Краткое описание обычной карточки. */
  summary: string;
  /* Markdown описания. */
  description: string;
  /* Адрес нового приложения. */
  slug: string;
  /* Префикс нового приложения; пустое значение оставляет default Core. */
  prefix: string;
  /* Назначение приложения из Contracts. */
  type: KnowledgeContentMap["application"]["type"];
  /* Сохраняемое состояние реализации. */
  status: KnowledgeContentMap["implementation"]["status"];
  /* Постоянный ID родителя нового сценария. */
  feature: string | null;
  /* Постоянный ID новой цели реализации. */
  target: string | null;
  /* Каталог выбора цели; не отправляется в Core. */
  targetKind: "feature" | "scenario";
}

/**
 * Черновик удерживает исходные версии карточки и приложения до закрытия сценария.
 */
export interface KnowledgeEditorDraft {
  /* Тип редактируемого знания. */
  readonly kind: CatalogKind;
  /* Исходная карточка при редактировании; null при создании. */
  readonly source: KnowledgeSnapshot | null;
  /* Исходное приложение-владелец при создании реализации. */
  readonly owner: KnowledgeSnapshot | null;
  /* Изменяемый пользователем ввод. */
  readonly values: KnowledgeValues;
}
