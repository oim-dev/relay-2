import type { TaskCriterion } from "../tasks/tasks.types";
import type { PlanScope, PlanStage } from "../planning/planning.types";
import type { DocumentRelation, DocumentSection } from "../knowledge/knowledge.types";
import type { HistoryRun } from "../history/history.types";
import type { EntityRecord } from "../entities/entity.types";
import type { componentCollectionNames } from "./component.constants";

/**
 * Нормализуемые поля raw-агрегатов; отсутствие отличается от присутствующей пустой коллекции.
 */
export type ComponentCollectionName = (typeof componentCollectionNames)[number];

/**
 * Закрытое соответствие вида первичной части её сохранённому значению.
 * Авторство присутствует лишь там, где оно действительно было частью предметного значения.
 */
export interface ComponentValueMap {
  /* Наличие массива верхнего уровня, в том числе пустого. */
  collection: {
    /* Верхнеуровневое поле владельца, присутствие которого сохраняет декларация. */
    readonly field: ComponentCollectionName;
  };
  /* Критерий с прежним ID внутри задачи. */
  "task-criterion": Readonly<TaskCriterion>;
  /* Одно обязательство задачи. */
  "task-dependency": {
    /* Постоянный ID обязательной задачи в проекте, не ключ или алиас. */
    readonly taskId: string;
  };
  /* Одна необязательная связь задач. */
  "task-related": {
    /* Постоянный ID связанной задачи в проекте, не ключ или алиас. */
    readonly taskId: string;
  };
  /* Одна предметная цель задачи. */
  "task-target": {
    /* Постоянный ID предметной цели; допустимый вид проверяет Core. */
    readonly targetId: string;
  };
  /* Содержание этапа; его состав хранится отдельными plan-task. */
  "plan-stage": Readonly<Omit<PlanStage, "taskIds">>;
  /* Одно включение задачи в этап данного плана. */
  "plan-task": {
    /* Scoped ID этапа внутри плана-владельца. */
    readonly stageId: string;
    /* Постоянный ID включённой задачи в проекте. */
    readonly taskId: string;
  };
  /* Одно включение цели в область плана. */
  "plan-scope": Readonly<PlanScope>;
  /* Участник плана; имя не является авторством изменения этой части. */
  "plan-participant": {
    /* Точное имя участника, допускающее lossless JSON-текст; не идентичность автора. */
    readonly participant: string;
  };
  /* Одно включение плана в релиз. */
  "release-plan": {
    /* Постоянный ID плана, включённого в релиз-владелец. */
    readonly planId: string;
  };
  /* Отношение с отдельным ID назначения, а не только парой target/type. */
  "document-relation": Readonly<DocumentRelation>;
  /* Первоначальное участие и разрешённый переход его завершения. */
  "session-run": Readonly<HistoryRun>;
  /* Раздел с прежним ID внутри проекта. */
  "document-section": Readonly<DocumentSection>;
  /* Неизменяемый резерв удалённого раздела; неизвестное историческое имя не выдумывается. */
  "section-reservation": {
    /* Снятый scoped ID раздела внутри проекта; повторное использование запрещено. */
    readonly sectionId: string;
  };
  /* Включение реализации в активный состав приложения. */
  "application-participation": {
    /* Постоянный ID реализации в активном составе приложения-владельца. */
    readonly implementationId: string;
  };
  /* Первичное назначение ID/ключа/алиаса; текущая роль выводится из владельца. */
  "address-assignment": {
    /* ID, читаемый ключ или алиас в общем пространстве адресов проекта. */
    readonly ref: string;
  };
}

/**
 * Виды независимо версионируемых частей из закрытой карты значений.
 */
export type ComponentKind = keyof ComponentValueMap;

/**
 * Raw owner подходит как локальной карточке, так и portable record без локального revision.
 */
export type ComponentRecord = Omit<EntityRecord, "revision"> & { readonly revision?: number };

/**
 * Одна ветвь переносимой первичной записи. PK = ownerId/kind/id, поскольку старые IDs scoped.
 */
interface ComponentOfKind<K extends ComponentKind> {
  /* Постоянный ID части внутри owner/kind; remove/readd назначения создаёт новый ID. */
  readonly id: string;
  /* Вид, определяющий форму value. */
  readonly kind: K;
  /* Постоянный ID владельца агрегата. */
  readonly ownerId: string;
  /* Плотный order key; сравнение по UTF-16 code units, ID стабилизирует равные ключи. */
  readonly position: string;
  /* Переносимая версия независимо от числового CAS владельца. */
  readonly version: string;
  /* Непосредственные предки версии без повторов, в каноническом порядке. */
  readonly parents: readonly string[];
  /* Tombstone сохраняет ID, последнее значение и позицию. */
  readonly deleted: boolean;
  /* Точное сохранённое значение согласно kind, без effective-проекций. */
  readonly value: ComponentValueMap[K];
}

/**
 * Переносимая часть с проверяемой связью kind/value.
 */
export type PortableComponent<K extends ComponentKind = ComponentKind> = {
  [P in K]: ComponentOfKind<P>;
}[K];

/**
 * Механически выделенная часть до назначения нового ID и версии адаптером.
 */
export type ComponentSeed = {
  [K in ComponentKind]: {
    /* Вид значения. */
    readonly kind: K;
    /* Прежний scoped ID; null у назначения без собственного ID в старом DTO. */
    readonly id: string | null;
    /* Естественный ключ для сопоставления действующего включения внутри владельца и вида. */
    readonly identity: string;
    /* Коллекция владельца; null у отдельного адреса. */
    readonly collection: ComponentCollectionName | null;
    /* Группа упорядочения; task memberships группируются по stageId. */
    readonly group: string;
    /* Выделенное точное значение. */
    readonly value: ComponentValueMap[K];
  };
}[ComponentKind];

/**
 * Результат механического разложения карточки без генерации идентичностей и без I/O.
 */
export interface ComponentLayout<T extends ComponentRecord = EntityRecord> {
  /* Raw owner с удалёнными нормализованными массивами и без проекции comments. */
  readonly record: T;
  /* Части в исходном предметном порядке, включая декларации пустых массивов. */
  readonly seeds: readonly ComponentSeed[];
  /* Неверные формы оставлены в owner payload для явной диагностики, а не заменены []. */
  readonly malformed: readonly ComponentCollectionName[];
}
