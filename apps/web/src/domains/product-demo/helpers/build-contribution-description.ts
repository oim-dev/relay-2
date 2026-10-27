import {
  APPLICATION_CHECK_SEEDS,
  CONTRIBUTION_CHECK_SEEDS,
} from "../config/contribution-check-seeds";

/** Вход для предметного Markdown-контракта демонстрационного вклада. */
export type ContributionDescriptionInput = {
  /** Приложение со своей границей ответственности. */
  applicationId: string;
  /** Цель и ожидаемая реализация. */
  intent: string;
  /** Выбранные сценарии с названиями и собственными реализациями. */
  scenarios: {
    /** Постоянный ID сценария. */ id: string;
    /** Пользовательское название. */ name: string;
    /** Ожидаемая реализация. */ intent: string;
  }[];
};

/**
 * Создаёт читаемый контракт мока: объём работы, границы, проверки и критерии приёмки.
 */
export const buildContributionDescription = (input: ContributionDescriptionInput): string => {
  const application = APPLICATION_CHECK_SEEDS[input.applicationId];
  const implementation = input.scenarios
    .map(
      (scenario) =>
        `### ${scenario.name}\n${scenario.intent
          .split(/(?<=[.!?])\s+/)
          .map((requirement) => `- ${requirement}`)
          .join("\n")}`,
    )
    .join("\n\n");
  const checks = input.scenarios.flatMap((scenario) =>
    (CONTRIBUTION_CHECK_SEEDS[scenario.id] ?? []).map(
      (check) => `- **${scenario.name}:** ${check}`,
    ),
  );
  const applicationChecks =
    application?.checks.map((check, index) => `${index + 1}. ${check}`).join("\n") ?? "";
  return `## Цель вклада\n${input.intent}\n\n## Что нужно реализовать\n${implementation}\n\n## Границы ответственности\n${application?.boundary ?? "Соблюдать общий контракт продукта и согласованные границы приложения."}\n\n## Как проверять\n### Сквозные условия сценариев\n${checks.join("\n")}\n\n### Проверка части приложения\n${applicationChecks}\n\n## Критерии готовности\n| Условие | Ожидаемый результат |\n| --- | --- |\n| Основной путь | Заявленное поведение выполняется целиком в границах приложения |\n| Ошибки и повтор | Отказ понятен, повтор безопасен, данные не потеряны |\n| Интеграция | Контракт согласован с остальными приложениями и общий сценарий проверяем |\n| Подтверждение | Сохранены результат проверки и существенные ограничения |\n\n> Статус «Готово» относится к реализации этого приложения. Общая готовность продукта будет учитывать вклад всех участвующих приложений.`;
};
