/**
 * Вариант выбора проекта, сформированный только из уже прочитанного ServerContext.
 */
export interface ProjectSelectionOption {
  /* Уникальный UI-token; никогда не передаётся Server как адрес проекта. */
  readonly value: string;
  /* Все имена доступных алиасов либо имя отдельной недоступной регистрации. */
  readonly label: string;
  /* Постоянный ID проекта для навигации; null у недоступного варианта. */
  readonly projectId: string | null;
  /* Имена регистраций в исходном порядке, без нормализации пользовательского текста. */
  readonly names: readonly string[];
  /* Недоступная регистрация остаётся видимой, но не выбирается. */
  readonly disabled: boolean;
}

/**
 * Внутренняя изменяемая группа только для построения списка за один проход.
 */
export interface ProjectSelectionGroup extends Omit<ProjectSelectionOption, "label" | "names"> {
  /* Собственный массив группы; входные ServerProject не изменяются. */
  readonly names: string[];
}
