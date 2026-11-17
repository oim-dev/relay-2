/**
 * Диагностики чтения общего состояния Relay без изменения хранилищ.
 */
export const statusMessages = {
  failed: "Не удалось прочитать локальное состояние Relay",
  invalidProject: "База не содержит корректную карточку ожидаемого проекта",
  mismatch: "ID базы не совпадает с ID каталога или конфигурации",
  workspaceRequired: "Выбор --project требует конфигурацию workspace",
  unknownProject: "Указанное имя проекта отсутствует в workspace",
  projectRequired: "Регистрация workspace должна ссылаться на проектный конфиг",
};
