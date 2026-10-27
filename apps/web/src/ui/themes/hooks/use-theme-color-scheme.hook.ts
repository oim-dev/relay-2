import { useMantineColorScheme } from "@mantine/core";

/**
 * Предоставляет выбор светлой, тёмной либо системной схемы владельцу переключателя.
 */
export const useThemeColorScheme = (): ReturnType<typeof useMantineColorScheme> =>
  useMantineColorScheme();
