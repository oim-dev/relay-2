/** Подписи известных предметных состояний в общей карточке. */
const ENTITY_STATUS_LABELS: Record<string, string> = {
  none: "Не начато",
  partial: "Частично",
  uninitialized: "Не заполнено",
  planned: "Запланировано",
  active: "Активно",
  draft: "Черновик",
  inbox: "Входящие",
  ready: "Готово к работе",
  "in-progress": "В работе",
  in_progress: "В работе",
  progress: "В работе",
  review: "На проверке",
  done: "Готово",
  completed: "Завершён",
  released: "Выпущен",
  cancelled: "Отменено",
  archived: "В архиве",
  outdated: "Устарело",
  blocked: "Заблокировано",
};

/**
 * Сохраняет неизвестное состояние видимым вместо угадывания его смысла.
 */
export const getEntityStatusLabel = (status: string): string =>
  ENTITY_STATUS_LABELS[status] ?? status;
