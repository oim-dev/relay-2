/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { SWRConfig } from "swr";
import { ProjectScope } from "domains/project";
import { removeSessionStored, writeSessionStored } from "infra/browser-storage";
import { GeneralSettings } from "./general-settings";

describe("Доступность восстановления настроек в форме", () => {
  test("восстановленный pending оставляет submit доступным после собственного SSE и закрывает редактирование/reset", () => {
    const projectId = "settings-pending-render";
    const key = `relay:project-settings:${projectId}`;
    writeSessionStored(key, {
      name: "Моё имя",
      slug: "my-name",
      ifRevision: 7,
      pending: { name: "Моё имя", slug: "my-name", ifRevision: 7 },
    });
    try {
      // SSR проверяет фактические disabled-атрибуты существующего UI, не lifecycle браузерных effects.
      const html = renderToStaticMarkup(
        createElement(
          MantineProvider,
          null,
          createElement(
            SWRConfig,
            {
              value: {
                /**
                 * Не разделяет GET-кеш SSR-проверки с остальными тестами.
                 */
                provider: () => new Map(),
              },
            },
            createElement(
              ProjectScope,
              { projectId },
              createElement(GeneralSettings, {
                settings: { name: "Моё имя", slug: "my-name", revision: 8 },
              }),
            ),
          ),
        ),
      );
      const submit = html.match(/<button\b[^>]*type="submit"[^>]*>/)?.[0];
      const reset = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
        .find(([button]) => button.includes("Отменить"))?.[0]
        .split(">")[0];

      expect(submit).toBeDefined();
      expect(submit).not.toContain("disabled");
      expect(reset).toContain("disabled");
      expect(html).toMatch(/<fieldset\b[^>]*disabled/);
      expect(html).toContain("Ожидаем подтверждение сохранения");
      expect(html).not.toContain("Оставить мой вариант");
    } finally {
      removeSessionStored(key);
    }
  });
});
