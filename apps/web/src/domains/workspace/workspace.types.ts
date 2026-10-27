/**
 * Регистрация проекта для навигации; канонический URL всегда использует id.
 */
export interface WorkspaceProject {
  /* Имя исходной регистрации, не идентификатор БД. */
  readonly key: string;
  /* Постоянный ID либо локальный идентификатор недоступной регистрации. */
  readonly id: string;
  /* Имена регистраций одного проекта для выбора. */
  readonly name: string;
  /* Известный slug bootstrap-контекста; не канонический URL. */
  readonly slug?: string;
  /* Имена регистраций и известный slug; неоднозначность проверяет resolver. */
  readonly aliases: readonly string[];
  /* Возможность открыть именно эту зарегистрированную базу. */
  readonly available: boolean;
  /* Причина недоступности; отсутствие не означает ошибку. */
  readonly error?: string;
}

/**
 * Проверенная область текущего Server для выбора независимого проекта.
 */
export interface RelayWorkspace {
  /* Один проект либо workspace. */
  readonly mode: "local" | "workspace";
  /* Постоянный ID локального проекта; null без единственного выбора. */
  readonly defaultProject: string | null;
  /* Регистрации в исходном порядке, включая недоступные. */
  readonly projects: readonly WorkspaceProject[];
}
