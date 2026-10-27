import dayjs from "dayjs";
import "dayjs/locale/ru";

/**
 * Показывает серверный момент времени в часовом поясе текущего браузера.
 */
export const formatDateTime = (timestamp: string): string =>
  dayjs(timestamp).locale("ru").format("D MMM YYYY, HH:mm");
