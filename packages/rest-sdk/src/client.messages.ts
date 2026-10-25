/**
 * Диагностики SDK на границе запроса и HTTP envelope.
 */
export const clientMessages = {
  invalidResponse: "Сервер вернул неверную HTTP-оболочку",
  /**
   * Описывает отсутствующий обязательный параметр генерируемого route.
   */
  missingParameter: (name: string): string => `Не задан параметр адреса ${name}`,
} as const;
