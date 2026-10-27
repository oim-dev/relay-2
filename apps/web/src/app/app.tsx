import { RouterProvider } from "react-router-dom";
import { DataProvider } from "infra/query-cache";
import { ThemeProvider } from "ui/themes";
import { appRouter } from "./router/app-router";

/**
 * Подключает публичные провайдеры и маршруты приложения.
 *
 * Используется для:
 *  - запуска браузерного рабочего пространства
 */
export const App = () => (
  <ThemeProvider>
    <DataProvider>
      <RouterProvider router={appRouter} />
    </DataProvider>
  </ThemeProvider>
);
