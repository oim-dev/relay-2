/**
 * Диагностики воспроизводимой генерации HTTP schemas.
 */
export const generatorMessages = {
  missingCatalog: "Генератор не вернул каталог HTTP schemas",
  parserContract: "Генератор изменил контракт parser chain",
  arrayLiteral: "Ожидался array literal",
  initializer: "Spread контрактов должен иметь const initializer",
  tuple: "Spread контрактов должен адресовать const tuple",
} as const;
