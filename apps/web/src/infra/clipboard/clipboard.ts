/**
 * Копирует текст через браузерный API по явному действию пользователя.
 */
export const copyText = async (text: string): Promise<void> => navigator.clipboard.writeText(text);
