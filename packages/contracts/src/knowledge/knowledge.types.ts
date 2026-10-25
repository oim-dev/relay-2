import type { EntityData, EntityRecord } from "../entities/entity.types";
import type {
  APPLICATION_TYPES,
  DOCUMENT_KINDS,
  DOCUMENT_RELATION_TYPES,
  DOCUMENT_STATUSES,
  DOCUMENT_TARGET_KINDS,
  IMPLEMENTATION_STATUSES,
  KNOWLEDGE_KINDS,
} from "./knowledge.constants";

/**
 * Вид знания, выведенный из общего перечня KNOWLEDGE_KINDS.
 */
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

/**
 * Раздел документов, принадлежащий паспорту проекта и его ревизии.
 */
export interface DocumentSection {
  /* Постоянный ID раздела внутри проекта; после удаления остаётся зарезервированным. */
  id: string;
  /* Непустое однострочное название раздела для отображения. */
  name: string;
}

/**
 * Разрешённый адрес цели отношения документа без загрузки её содержания.
 */
interface DocumentRelationTarget {
  /* Вид цели из DOCUMENT_TARGET_KINDS. */
  kind: (typeof DOCUMENT_TARGET_KINDS)[number];
  /* Постоянный ID целевой записи в том же проекте. */
  id: string;
}

/**
 * Структурированное отношение документа к одной цели.
 * Пара «ID цели, вид отношения» уникальна в документе; самоссылки запрещены.
 */
export interface DocumentRelation {
  /* Цель по постоянному ID и проверенному виду. */
  target: DocumentRelationTarget;
  /* Семантика отношения из DOCUMENT_RELATION_TYPES. */
  type: (typeof DOCUMENT_RELATION_TYPES)[number];
  /* Пояснение отношения; пустая строка допустима. */
  description: string;
}

/**
 * Поля паспорта локального проекта и его каталога разделов документов.
 */
interface ProjectFields {
  /* Каноническое имя проекта по правилу isProjectName. */
  name: string;
  /* Канонический адрес проекта по правилу isEntitySlug. */
  slug: string;
  /* Разделы в пользовательском порядке; отсутствие у нового проекта означает пустой каталог. */
  documentSections?: DocumentSection[];
  /* Зарезервированные ID удалённых разделов без повторов; отсутствие равнозначно пустому списку. */
  retiredDocumentSectionIds?: string[];
}

/**
 * Содержимое паспорта проекта; необязательные списки не допускают null.
 * Каталог разделов и резервирование их ID изменяются под ревизией проекта.
 */
export type ProjectData = EntityData<ProjectFields>;

/**
 * Независимо заполняемые поля паспорта продукта; при инициализации все отсутствуют.
 */
interface ProductFields {
  /* Непустое название продукта; отсутствие означает ещё не заполненное поле. */
  name?: string;
  /* Краткое описание; отсутствие означает незаполненное поле, пустая строка допустима. */
  summary?: string;
  /* Подробное описание; отсутствие означает незаполненное поле, пустая строка допустима. */
  description?: string;
}

/**
 * Содержимое паспорта продукта, совместимое с JSON-контрактом хранения.
 */
export type ProductData = EntityData<ProductFields>;

/**
 * Общие текстовые поля функциональности, сценария и приложения.
 */
interface FeatureFields {
  /* Непустое однострочное название предметной записи. */
  name: string;
  /* Краткое описание; пустая строка допустима. */
  summary: string;
  /* Подробное описание; пустая строка допустима. */
  description: string;
}

/**
 * Описание функциональности продукта без связей с реализациями.
 */
export type FeatureData = EntityData<FeatureFields>;

/**
 * Текст сценария и его принадлежность функциональности продукта.
 */
interface ScenarioFields extends FeatureFields {
  /* Постоянный ID функциональности, которой принадлежит сценарий. */
  featureId: string;
}

/**
 * Содержимое сценария, совместимое с JSON-контрактом хранения.
 */
export type ScenarioData = EntityData<ScenarioFields>;

/**
 * Описание приложения, его адреса и состав реализаций.
 */
interface ApplicationFields extends FeatureFields {
  /* Канонический адрес приложения по правилу isEntitySlug. */
  slug: string;
  /* Префикс ключей: заглавные латинские буквы, цифры и дефисы; начинается с буквы. */
  prefix: string;
  /* Назначение приложения из APPLICATION_TYPES. */
  type: (typeof APPLICATION_TYPES)[number];
  /* Постоянный ID связанной доски задач приложения. */
  boardId: string;
  /* Постоянные ID реализаций приложения без повторов. */
  implementationIds: string[];
}

/**
 * Содержимое приложения с проверенными структурированными связями.
 */
export type ApplicationData = EntityData<ApplicationFields>;

/**
 * Поля доски задач продукта либо отдельного приложения.
 */
interface BoardFields {
  /* Непустое однострочное название доски. */
  name: string;
  /* Адрес доски по isEntitySlug; у начальной продуктовой доски равен product. */
  slug: string;
  /* Префикс задач доски; у начальной продуктовой доски равен PRODUCT. */
  prefix: string;
  /* Описание доски; у начальной продуктовой доски отсутствует. */
  description?: string;
  /* Постоянный ID приложения; отсутствие обозначает продуктовую доску. */
  applicationId?: string;
}

/**
 * Содержимое доски; отсутствие необязательных полей не заменяется null.
 */
export type BoardData = EntityData<BoardFields>;

/**
 * Общие поля реализации функциональности или сценария в приложении.
 */
interface ImplementationFields {
  /* Непустой однострочный заголовок реализации. */
  title: string;
  /* Описание реализации; пустая строка допустима. */
  description: string;
  /* Степень реализации из IMPLEMENTATION_STATUSES. */
  status: (typeof IMPLEMENTATION_STATUSES)[number];
  /* Признак действующей реализации, независимый от степени её готовности. */
  active: boolean;
  /* Постоянный ID приложения, содержащего реализацию. */
  applicationId: string;
  /* Постоянный ID функциональности, общей для обоих вариантов цели. */
  featureId: string;
  /* Постоянный ID цели: featureId либо scenarioId в зависимости от targetKind. */
  targetId: string;
}

/**
 * Реализация всей функциональности без привязки к отдельному сценарию.
 */
interface FeatureImplementationFields extends ImplementationFields {
  /* Дискриминатор цели; targetId должен совпадать с featureId. */
  targetKind: "feature";
  /* Поле запрещено для цели-функциональности. */
  scenarioId?: never;
}

/**
 * Реализация отдельного сценария функциональности.
 */
interface ScenarioImplementationFields extends ImplementationFields {
  /* Дискриминатор цели; targetId должен совпадать с scenarioId. */
  targetKind: "scenario";
  /* Постоянный ID сценария, принадлежащего featureId. */
  scenarioId: string;
}

/**
 * Содержимое реализации с формой цели, определяемой targetKind.
 * EntityData сохраняет дискриминированное объединение и совместимость с хранением.
 */
export type ImplementationData =
  EntityData<FeatureImplementationFields> | EntityData<ScenarioImplementationFields>;

/**
 * Поля документа, его размещения и структурированных отношений.
 */
interface DocumentFields {
  /* Непустое однострочное название документа. */
  name: string;
  /* Краткое описание; пустая строка допустима. */
  summary: string;
  /* Непустое основное содержимое документа. */
  body: string;
  /* Предметный вид документа из DOCUMENT_KINDS. */
  documentKind: (typeof DOCUMENT_KINDS)[number];
  /* Состояние публикации из DOCUMENT_STATUSES. */
  documentStatus: (typeof DOCUMENT_STATUSES)[number];
  /* ID раздела проекта; null означает отсутствие раздела. */
  sectionId: string | null;
  /* Признак закрепления документа при отображении списков. */
  pinned: boolean;
  /* Отношения в сохранённом порядке, уникальные по паре цели и вида. */
  relations: DocumentRelation[];
}

/**
 * Содержимое документа; Core при чтении учитывает удалённые разделы проекта.
 */
export type DocumentData = EntityData<DocumentFields>;

/**
 * Соответствие вида знания его проверенной схеме содержания.
 */
export interface KnowledgeDataMap {
  /* Паспорт проекта и каталог разделов документов. */
  project: ProjectData;
  /* Паспорт описываемого продукта. */
  product: ProductData;
  /* Функциональность продукта. */
  feature: FeatureData;
  /* Сценарий конкретной функциональности. */
  scenario: ScenarioData;
  /* Приложение продукта и его состав. */
  application: ApplicationData;
  /* Реализация функциональности либо сценария в приложении. */
  implementation: ImplementationData;
  /* Документ с размещением и отношениями. */
  document: DocumentData;
  /* Доска задач продукта или приложения. */
  board: BoardData;
}

/**
 * Одна ветвь записи знания; объединение ветвей формирует KnowledgeRecord.
 */
interface KnowledgeRecordOfKind<K extends KnowledgeKind> extends Omit<
  EntityRecord,
  "kind" | "data"
> {
  /* Вид знания, выбирающий соответствующую схему содержания. */
  kind: K;
  /* Проверенное содержимое выбранного вида из KnowledgeDataMap. */
  data: KnowledgeDataMap[K];
}

/**
 * Проверенная запись Core с дискриминацией по kind, в отличие от сырого EntityRecord.
 * Параметр K ограничивает допустимые виды, сохраняя связь каждого вида с data.
 */
export type KnowledgeRecord<K extends KnowledgeKind = KnowledgeKind> = {
  [P in K]: KnowledgeRecordOfKind<P>;
}[K];

/**
 * Упорядоченный каталог разделов и ревизия проекта из одного снимка.
 */
export interface DocumentSections {
  /* Текущий читаемый ключ проекта-владельца разделов. */
  project: string;
  /* Ревизия содержания проекта, требуемая для изменения разделов. */
  revision: number;
  /* Разделы в пользовательском порядке; пустой массив означает отсутствие разделов. */
  items: DocumentSection[];
}

/**
 * Проверенные отношения документа и его ревизия из одного снимка.
 */
export interface DocumentLinks {
  /* Текущий читаемый ключ документа-владельца отношений. */
  ref: string;
  /* Ревизия содержания документа, включающего отношения. */
  revision: number;
  /* Отношения в сохранённом порядке; пустой массив означает отсутствие связей. */
  items: DocumentRelation[];
}
