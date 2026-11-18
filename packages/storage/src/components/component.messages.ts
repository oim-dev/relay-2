/**
 * Диагностики первичного SQL-хранения и технического импорта частей.
 */
export const componentStorageMessages = {
  shape: "Неверная сохранённая нормализованная часть",
  retired: "ID снятой части уже зарезервирован",
  importRequired: "Импорт частей требует техническую транзакцию Core",
  snapshot: "Некорректный снимок частей",
  addressReserved: "Назначения адресов сохраняются в резерве",
  tombstoneRequired: "Снятие части требует сохраняемого tombstone",
  immutableHistory: "Идентичность или история части неизменяема",
} as const;
