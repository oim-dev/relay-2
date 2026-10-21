import type { completionShells } from "./completion.constants";

/**
 * Поддерживаемая оболочка для генерации скрипта подключения.
 */
export type CompletionShell = (typeof completionShells)[number];

/**
 * Проверенный запрос служебной команды; слова после -- передаются без исполнения и разбора полей.
 */
export type CompletionRequest =
  | {
      /* Пустой вызов показывает справку. */
      readonly kind: "help";
    }
  | {
      /* Запрос shell-скрипта для однократного подключения. */
      readonly kind: "script";
      /* Имя поддерживаемой оболочки. */
      readonly shell: CompletionShell;
    }
  | {
      /* Запрос кандидатов для незавершённой командной строки. */
      readonly kind: "query";
      /* Уже введённые слова, включая пустое слово под курсором. */
      readonly words: readonly string[];
    };
