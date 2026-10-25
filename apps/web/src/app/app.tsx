import type { ReactElement } from "react";
import { SWRConfig } from "swr";
import { RouterProvider } from "react-router-dom";
import { ThemeProvider } from "ui/themes";
import { router } from "./router/app-router";

/**
 * Связывает визуальный Provider, GET-кеш и дерево маршрутов приложения.
 */
export function App(): ReactElement {
  return (
    <ThemeProvider>
      <SWRConfig
        value={{ revalidateOnFocus: true, shouldRetryOnError: false, keepPreviousData: false }}
      >
        <RouterProvider router={router} />
      </SWRConfig>
    </ThemeProvider>
  );
}
