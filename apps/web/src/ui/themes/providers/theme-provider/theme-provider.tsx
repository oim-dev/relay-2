import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { theme, themeVariables } from "../../config/theme.config";
import type { ThemeProviderProps } from "./types/theme-provider-props.type";
import "../../styles/index.css";

/**
 * Подключает визуальную систему Tasks и цветовые схемы.
 *
 * Используется для:
 *  - согласованного оформления доски, диалогов и уведомлений
 */
export const ThemeProvider = (props: ThemeProviderProps) => {
  return (
    <MantineProvider theme={theme} cssVariablesResolver={themeVariables} defaultColorScheme="auto">
      <Notifications position="bottom-right" limit={3} />
      {props.children}
    </MantineProvider>
  );
};
