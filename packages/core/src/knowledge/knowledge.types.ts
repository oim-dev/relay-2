import type {
  ApplicationData,
  DocumentData,
  DocumentRelation,
  EntityKind,
  EntityRecord,
  FeatureData,
  ImplementationData,
  KnowledgeKind,
  KnowledgeRecord,
  ProductData,
  ProjectData,
  WriteOptions,
} from "@relay/contracts";

/**
 * Сырой объект публичной границы; предметные шаги получают результат разбора.
 */
export type KnowledgeInput = Readonly<Record<string, unknown>>;

/**
 * Активное участие и владелец его ревизии из одного согласованного снимка.
 */
export interface ApplicationParticipation {
  /* Текущий ключ приложения, включая обращение по прежнему алиасу. */
  readonly application: string;
  /* Ревизия приложения для замены всего состава участия. */
  readonly revision: number;
  /* Полные активные реализации в порядке list по ключу и ID; снятая история исключена. */
  readonly items: KnowledgeRecord<"implementation">[];
}

/**
 * Проверенные тексты и статус реализации без связей и признака участия.
 */
export type ImplementationContent = Readonly<
  Pick<ImplementationData, "title" | "description" | "status">
>;

/**
 * Проверенные данные нового приложения до создания принадлежащей ему доски.
 */
export type ApplicationCreationData = Readonly<
  Omit<ApplicationData, "boardId" | "implementationIds">
>;

/**
 * Проверенное отношение до разрешения пользовательской ссылки в постоянный ID.
 */
export interface KnowledgeRelationInput {
  /* Пользовательская ссылка либо ссылка с явно указанным видом цели. */
  readonly target: string | Readonly<DocumentRelation["target"]>;
  /* Вид отношения, по умолчанию documents на границе ввода. */
  readonly type: DocumentRelation["type"];
  /* Полный текст пояснения; пустая строка означает отсутствие пояснения. */
  readonly description: string;
}

/**
 * Данные создания по виду знания; ссылки ещё требуют разрешения под транзакцией.
 */
export interface KnowledgeCreationMap {
  /* Паспорт заполняет существующую пустую запись. */
  readonly product: {
    /* Полные тексты для первичного заполнения паспорта. */
    readonly data: Readonly<FeatureData>;
  };
  /* Самостоятельная фича без связей. */
  readonly feature: {
    /* Полные тексты новой фичи. */
    readonly data: Readonly<FeatureData>;
  };
  /* Сценарий и пользовательская ссылка на его фичу. */
  readonly scenario: {
    /* Полные тексты нового сценария. */
    readonly data: Readonly<FeatureData>;
    /* Пользовательская ссылка на фичу-владельца. */
    readonly feature: string;
  };
  /* Приложение с адресом будущей доски. */
  readonly application: {
    /* Содержание приложения и неизменяемые адреса будущей доски. */
    readonly data: ApplicationCreationData;
  };
  /* Содержание реализации и пользовательские ссылки на приложение и цель. */
  readonly implementation: {
    /* Тексты и статус нового участия. */
    readonly data: ImplementationContent;
    /* Пользовательская ссылка на приложение-владельца. */
    readonly application: string;
    /* Пользовательская ссылка на фичу или сценарий. */
    readonly target: string;
  };
  /* Документ и проверенные по форме отношения без разрешения целей. */
  readonly document: {
    /* Полное содержание; раздел проверяется по проекту в транзакции. */
    readonly data: Readonly<Omit<DocumentData, "relations">>;
    /* Отношения в порядке ввода; уникальность проверяется после разрешения целей. */
    readonly relations: readonly KnowledgeRelationInput[];
  };
}

/**
 * Вид создаваемой записи определяет допустимые данные и ссылки команды.
 */
export type KnowledgeCreation = {
  [K in keyof KnowledgeCreationMap]: {
    /* Вид определяет проверенные поля и ссылки создаваемой записи. */
    readonly kind: K;
  } & KnowledgeCreationMap[K];
}[keyof KnowledgeCreationMap];

/**
 * Только изменяемое содержание каждого вида, без служебных полей и состава участия.
 */
export interface KnowledgePatchMap {
  /* Название и slug проекта; разделы изменяются отдельным сценарием. */
  readonly project: Partial<Pick<ProjectData, "name" | "slug">>;
  /* Независимое заполнение полей пустого паспорта допускается. */
  readonly product: Partial<ProductData>;
  /* Тексты фичи. */
  readonly feature: Partial<FeatureData>;
  /* Тексты сценария; фича после создания неизменяема. */
  readonly scenario: Partial<FeatureData>;
  /* Тексты и тип приложения; адрес доски неизменяем. */
  readonly application: Partial<Pick<ApplicationData, "name" | "summary" | "description" | "type">>;
  /* Тексты и статус реализации; участие изменяется отдельным сценарием. */
  readonly implementation: Partial<ImplementationContent>;
  /* Содержание документа без требующих разрешения отношений. */
  readonly document: Partial<Omit<DocumentData, "relations">>;
}

/**
 * Проверенное изменение знания; отсутствие relations сохраняет прежние отношения.
 */
export type KnowledgeUpdate = {
  [K in keyof KnowledgePatchMap]: {
    /* Вид записи, для которого проверены изменяемые поля. */
    readonly kind: K;
    /* Только явно переданные поля; пустая команда отклоняется при разборе. */
    readonly data: Readonly<KnowledgePatchMap[K]>;
  } & (K extends "document"
    ? {
        /* Новый состав отношений; отсутствие сохраняет прежние пары. */
        readonly relations?: readonly KnowledgeRelationInput[];
      }
    : object);
}[keyof KnowledgePatchMap];

/**
 * Параметры публичной операции над одной парой цель + тип отношения.
 */
export interface KnowledgeLinkOptions extends WriteOptions {
  /* true снимает отношение; отсутствие означает добавление или уточнение. */
  readonly remove?: boolean;
  /* Вид отношения; отсутствие выбирает documents. */
  readonly type?: string;
  /* Новый полный текст пояснения; отсутствие сохраняет прежний. */
  readonly description?: string;
}

/**
 * Проверенное изменение одной пары отношения после разбора параметров.
 */
export interface KnowledgeLinkChange {
  /* Признак снятия отношения; описание при снятии запрещено. */
  readonly remove: boolean;
  /* Проверенный тип отношения. */
  readonly type: DocumentRelation["type"];
  /* Отсутствие сохраняет пояснение существующего отношения. */
  readonly description?: string;
}

/**
 * Допустимая цель FI/SI с проверенным содержанием.
 */
export type ImplementationTarget = KnowledgeRecord<"feature" | "scenario">;

/**
 * Разрешённая ссылка: содержание знаний проверено, прочими видами владеют их предметные сервисы.
 */
export type KnowledgeReference =
  | KnowledgeRecord
  | (Omit<EntityRecord, "kind"> & {
      /* Чужой предметный вид; его данные не используются правилами знаний. */
      readonly kind: Exclude<EntityKind, KnowledgeKind>;
    });

/**
 * Разрешение ссылок внутри уже открытого снимка или транзакции вызывающей стороны.
 */
export interface KnowledgeResolver {
  /**
   * Возвращает проверенное знание ожидаемого вида либо ошибку ссылки/повреждения.
   */
  resolve<K extends KnowledgeKind>(ref: string, expectedKind: K): KnowledgeRecord<K>;
  /**
   * Разрешает произвольную сущность; содержание знаний проверяется до возврата.
   */
  resolve(ref: string, expectedKind?: EntityKind): KnowledgeReference;
}
