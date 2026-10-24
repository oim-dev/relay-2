import type { ChildProcess } from "node:child_process";
import type { GuardedCommandOptions } from "@relay/project-runtime";

/**
 * Изолированные пути и команды одного сценария владения процессным деревом.
 */
export interface GuardianFixture {
  /* Уникальный рабочий каталог под .artifacts. */
  readonly root: string;
  /* Запуск настоящей служебной роли: собранное приложение либо fixture-entry. */
  readonly component: readonly string[];
  /* Запуск тестового актора, исполняющего реальные дочерние процессы. */
  readonly actor: readonly string[];
  /* Базовые параметры с собственным HOME и полным окружением. */
  readonly options: GuardedCommandOptions;
}

/**
 * Барьер: непосредственная команда и оба уровня потомков уже выполняются.
 */
export interface TreeReady {
  /* PID непосредственной команды. */
  readonly command: number;
  /* PID живого якоря, группа которого принадлежит guardian. */
  readonly anchor: number;
  /* PID первого потомка команды. */
  readonly branch: number;
  /* PID вложенного потомка первого уровня. */
  readonly leaf: number;
}

/**
 * Отдельный владелец runGuardedCommand, которого тест может убить без остановки Bun test.
 */
export interface CommandOwner {
  /* Дочерний процесс владельца с отдельной группой. */
  readonly child: ChildProcess;
  /* Подтверждение выхода владельца; не означает очистку проверяемого дерева. */
  readonly exited: Promise<void>;
}
