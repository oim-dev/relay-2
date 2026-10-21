/**
 * Исходные метаданные новой базы: все значения должны быть непустыми строками.
 */
export interface ProjectMetadata {
  /* Постоянный ID проекта; одновременно становится ID корневой сущности. */
  readonly id: string;
  /* Отображаемое имя проекта в его начальной карточке. */
  readonly name: string;
  /* Строковый адрес проекта; предметные ограничения проверяет вызывающий Core/Runtime. */
  readonly slug: string;
}

/**
 * Единственная строка состояния проекта, читаемая при открытии базы.
 */
export interface ProjectStateRow {
  /* Постоянный ID существующей сущности вида project. */
  readonly project_id: string;
}

/**
 * Поколение подтверждённых изменений в текущем снимке соединения.
 */
export interface ProjectGenerationRow {
  /* Неотрицательный счётчик изменений сущностей и журнала комментариев. */
  readonly generation: number;
}

/**
 * Ответ SQLite на запрос режима журнала.
 */
export interface JournalModeRow {
  /* Имя режима; файловая база Relay требует значение wal. */
  readonly journal_mode: string;
}

/**
 * Техническая версия схемы из заголовка SQLite.
 */
export interface SchemaVersionRow {
  /* Версия схемы, совместимость которой проверяется до чтения сущностей. */
  readonly user_version: number;
}

/**
 * Маркер приложения из заголовка SQLite.
 */
export interface ApplicationIdRow {
  /* Числовой маркер Relay; чужая база не переинициализируется. */
  readonly application_id: number;
}
