import { useComputedColorScheme, useMantineColorScheme } from "@mantine/core";

/**
 * Предоставляет выбор светлой, тёмной либо системной схемы владельцу переключателя.
 */
export function useThemeColorScheme(): ReturnType<typeof useMantineColorScheme> {
  const controls = useMantineColorScheme();
  const colorScheme = useComputedColorScheme("light");
  return { ...controls, colorScheme };
}
