/**
 * Диагностики генерации: неполный каталог и висячие refs считаются отказом сборки спецификации.
 */
export const openapiMessages = {
  tags: "Некорректные Swagger tags",
  controllers: "API_CONTROLLERS не совпадает с реальной композицией Nest modules",
  /**
   * Описывает ссылку вне поддерживаемого замкнутого документа.
   */
  localReference: (reference: string): string =>
    `Ожидалась локальная ссылка JSON Schema: ${reference}`,
  /**
   * Описывает столкновение конечных identifiers.
   */
  nameCollision: (identifier: string): string => `Коллизия имён компонентов OpenAPI: ${identifier}`,
  /**
   * Описывает компонент, отсутствующий среди исходных definitions.
   */
  unknownComponent: (reference: string): string => `Неизвестный компонент в $ref: ${reference}`,
  /**
   * Описывает неразрешимую ссылку уже собранной спецификации.
   */
  danglingReference: (reference: string): string =>
    `Неразрешимая ссылка спецификации: ${reference}`,
  /**
   * Описывает несовместимую форму reflection metadata.
   */
  metadataArray: (key: string): string => `Ожидался массив metadata Nest: ${key}`,
  /**
   * Описывает неверный controller в module graph.
   */
  controller: (name: string): string => `Некорректный controller metadata: ${name}`,
  /**
   * Описывает import, для которого нужен явный способ чтения metadata.
   */
  moduleImport: (name: string): string =>
    `Неподдерживаемый deferred/async import metadata: ${name}`,
  /**
   * Описывает путь, не поддерживаемый текущим внешним контрактом.
   */
  routePath: (name: string): string => `Ожидался одиночный буквальный путь Nest: ${name}`,
  /**
   * Описывает handler без стабильного публичного имени.
   */
  operationId: (name: string): string => `Публичному handler нужен Swagger operationId: ${name}`,
  /**
   * Описывает handler с неподдерживаемым методом.
   */
  method: (name: string): string => `Неподдерживаемый метод Nest: ${name}`,
  /**
   * Описывает коллизию фактических маршрутов.
   */
  duplicateRoute: (method: string, path: string): string =>
    `Повторный маршрут Nest: ${method} ${path}`,
  /**
   * Описывает отсутствующий DTO операции.
   */
  missingSchema: (name: string): string => `Нет именованной схемы HTTP-сценария: ${name}`,
  /**
   * Описывает потерю единственной именованной успешной ветви общего envelope.
   */
  successReference: (name: string): string =>
    `Ожидалась одна именованная успешная ветвь HttpResponse: ${name}`,
  /**
   * Описывает неоднозначное либо отсутствующее имя операции.
   */
  duplicateOperation: (method: string, path: string): string =>
    `Отсутствующий или повторный operationId: ${method} ${path}`,
  /**
   * Описывает handler вне переносимого каталога.
   */
  unknownOperation: (name: string): string => `Неизвестный HTTP-сценарий в Nest: ${name}`,
  /**
   * Описывает расхождение decorator catalog и module graph.
   */
  routeMismatch: (name: string): string => `Nest маршрут не совпадает с каталогом: ${name}`,
  /**
   * Описывает операцию без реально зарегистрированного handler.
   */
  missingOperation: (name: string): string =>
    `Операция каталога не реализована контроллером Nest: ${name}`,
  /**
   * Описывает конфликт владельцев одинакового имени DTO.
   */
  duplicateComponent: (name: string): string =>
    `Swagger и Contracts объявляют один компонент: ${name}`,
  /**
   * Сравнивает полные наборы команд для диагностики нового/удалённого действия Core.
   */
  commandCatalog: (published: readonly string[], described: readonly string[]): string =>
    `Каталог OpenAPI не совпадает с Core: Core=${published.join(",")}; OpenAPI=${described.join(",")}`,
  /**
   * Описывает поле команды, пропущенное внешней схемой.
   */
  commandFields: (operation: string): string => `Поля OpenAPI не совпадают с Core: ${operation}`,
  /**
   * Описывает отсутствующую форму ввода команды.
   */
  commandInput: (operation: string): string => `Нет схемы input: ${operation}`,
  /**
   * Описывает адресный путь Core, который невозможно найти во внешней форме.
   */
  commandReference: (operation: string, path: string): string =>
    `Нет пути локальной ссылки в схеме ${operation}: ${path}`,
};
