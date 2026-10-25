/**
 * Переносимая декларация JSON Schema входа команды. Это описание wire-формы,
 * а не отдельный путь исполнения или проверки предметного состояния.
 */
export interface CommandJsonSchema {
  /* Ссылка на именованный компонент документа. */
  readonly $ref?: string;
  /* JSON-тип значения; nullable выражается отдельной ветвью. */
  readonly type?: "object" | "array" | "string" | "integer" | "boolean" | "null";
  /* Точное значение дискриминатора либо флага. */
  readonly const?: string | boolean;
  /* Предметные литералы из общих перечислений Contracts. */
  readonly enum?: readonly string[];
  /* Пояснение входа, владельца guards или значения отсутствующего поля. */
  readonly description?: string;
  /* Единственные разрешённые собственные поля объекта. */
  readonly properties?: Readonly<Record<string, CommandJsonSchema>>;
  /* Обязательные поля; отсутствие означает, что все свойства необязательны. */
  readonly required?: readonly string[];
  /* Запрет неизвестных свойств на каждом объектном уровне. */
  readonly additionalProperties?: false;
  /* Минимальное число полей частичного изменения. */
  readonly minProperties?: number;
  /* Схема каждого элемента массива в исходном порядке. */
  readonly items?: CommandJsonSchema;
  /* Нижняя граница размера списка. */
  readonly minItems?: number;
  /* Верхняя граница размера списка. */
  readonly maxItems?: number;
  /* Запрет точных дубликатов; дубли разрешённых ID проверяет Core. */
  readonly uniqueItems?: boolean;
  /* Нижняя граница целочисленной локальной CAS. */
  readonly minimum?: number;
  /* Верхняя граница безопасного целого JavaScript. */
  readonly maximum?: number;
  /* Минимальная длина непустого адреса. */
  readonly minLength?: number;
  /* Синтаксическое ограничение текстового поля без нормализации. */
  readonly pattern?: string;
  /* Ровно одна допустимая форма значения. */
  readonly oneOf?: readonly CommandJsonSchema[];
  /* Хотя бы одно условие, например CAS или переносимая версия. */
  readonly anyOf?: readonly CommandJsonSchema[];
  /* Совместно обязательные условия формы. */
  readonly allOf?: readonly CommandJsonSchema[];
  /* Запрещённое сочетание полей. */
  readonly not?: CommandJsonSchema;
  /* Копируемые JSON-примеры без сведений из пользовательской БД. */
  readonly examples?: readonly unknown[];
  /* Значение пропущенного поля при создании; схема его не подставляет. */
  readonly default?: unknown;
  /* OpenAPI-дискриминатор именованной команды. */
  readonly discriminator?: {
    /* Имя свойства, определяющего ветвь oneOf. */
    readonly propertyName: string;
  };
  /* Предметный владелец верхнеуровневого CAS/token; null у независимого создания. */
  readonly "x-relay-revision-owner"?: string | null;
  /* Разрешённые текущим каталогом Core пути локальных ссылок в input. */
  readonly "x-relay-reference-fields"?: readonly string[];
}
