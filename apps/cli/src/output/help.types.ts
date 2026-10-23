import type { CommandContext } from "gunshi";

/**
 * Копируемый пример одного вызова CLI; текст команды хранится вместе с пояснением.
 */
export interface HelpExample {
  /* Назначение примера; выводится как shell-комментарий перед вызовом. */
  readonly description: string;
  /* Полный вызов relay в синтаксисе POSIX shell, включая значимые переводы строк. */
  readonly command: string;
}

/**
 * Содержательная справка группы или действия; синтаксис параметров берётся из схем Gunshi.
 */
export interface CommandHelp {
  /* Краткое назначение для списка команд и заголовка собственной справки. */
  readonly description: string;
  /* Правила действия, источники нужных данных и переходы к связанным командам. */
  readonly details: string;
  /* Хотя бы один пример; у действия должен быть пример его выполнения. */
  readonly examples: readonly [HelpExample, ...HelpExample[]];
}

/**
 * Автономный renderer справки одного запуска Gunshi, не читающий проект или stdin.
 */
export type HelpRenderer = (context: Readonly<CommandContext>) => Promise<string>;
