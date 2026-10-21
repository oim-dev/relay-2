import type { EntityKind, KnowledgeRecord, ProjectEntity } from "@relay/contracts";

/**
 * Проверенный поисковый запрос до чтения снимка проекта.
 */
export interface EntitySearchRequest {
  /* Исходный непустой текст: также проверяется как точный адрес сущности. */
  readonly query: string;
  /* Ограничение вида; undefined включает все виды проекта. */
  readonly kind: EntityKind | undefined;
}

/**
 * Сводка задач одного снимка, включая готовность по общему графу обязательств.
 */
export interface ProjectTaskOverview {
  /* Число всех задач независимо от колонки и наличия блокеров. */
  total: number;
  /* Число задач каждой штатной колонки; пустые колонки представлены нулём. */
  columns: Record<string, number>;
  /* Число задач с незавершёнными прямыми обязательствами по правилам TaskGraph. */
  blocked: number;
}

/**
 * Полный предметный обзор проекта из согласованного снимка БД.
 */
export interface ProjectOverview {
  /* Проверенные карточки всех видов, отсортированные по ключу и затем по ID. */
  items: ProjectEntity[];
  /* Проверенная карточка проекта с ID открытой БД. */
  project: KnowledgeRecord<"project">;
  /* Поколение того же снимка, из которого прочитаны карточки и счётчики. */
  generation: number;
  /* Число записей каждого вида; отсутствующие виды имеют значение 0. */
  counts: Record<EntityKind, number>;
  /* Агрегаты задач, рассчитанные из того же состава карточек. */
  tasks: ProjectTaskOverview;
}

/**
 * Результат диагностики целостности без изменения проверенных данных.
 */
export interface ProjectCheck {
  /* Постоянный ID проекта, которому принадлежит открытая БД. */
  projectId: string;
  /* Поколение проверенного снимка. */
  generation: number;
  /* Отсутствие нарушений; при нарушениях QueryService.check выбрасывает INTEGRITY_ERROR. */
  valid: boolean;
  /* Число всех проверенных записей, включая повреждённые. */
  records: number;
  /* Диагностики в порядке проверки; у успешного результата массив пуст. */
  issues: string[];
}

/**
 * Техническое состояние проекта без загрузки содержания карточек.
 * Размер файла снимается с файловой системы и не входит в транзакционный снимок SQLite.
 */
export interface ProjectStatus {
  /* Постоянный ID проекта, которому принадлежит открытая БД. */
  projectId: string;
  /* Путь к основному SQLite-файлу выбранного проекта. */
  databasePath: string;
  /* Размер основного SQLite-файла в байтах без отдельных WAL/SHM-файлов. */
  bytes: number;
  /* Поколение общего снимка со счётчиком records. */
  generation: number;
  /* Число сущностей, полученное запросом COUNT без чтения JSON и комментариев. */
  records: number;
}
