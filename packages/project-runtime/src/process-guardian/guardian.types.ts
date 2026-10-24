import type { constants } from "node:os";
import type { guardianFailureStages } from "./diagnostics.constants";

/**
 * Запуск команды в автономном guardian без изменения cwd и окружения вызывающего.
 * Linux дополнительно удерживает setsid-потомков через subreaper; Windows — через Job Object.
 * На macOS управляется наследуемая группа: fork/exec и потеря родителя сохраняют PGID,
 * а выход через setsid/setpgid не перехватывается. Вызывающий выбирает foreground-режим
 * команды и helpers без смены группы; закрытие stdio само по себе владение не прекращает.
 * POSIX-группа не является контейнером, запрещающим новые fork во время очистки.
 */
export interface GuardedCommandOptions {
  /* Команда самого приложения: [бинарник] либо [bun, main.ts]. */
  readonly component: readonly string[];
  /* Исполняемый файл команды и дословные аргументы, без оболочки. */
  readonly argv: readonly string[];
  /* Рабочий каталог только запускаемой команды. */
  readonly cwd: string;
  /* Полное окружение команды; undefined исключает переменную. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /* Полное содержимое stdin команды; отсутствие означает пустой закрытый поток. */
  readonly input?: Uint8Array | string;
  /* Оставляет stdin команды открытым до остановки владельца; по умолчанию false. */
  readonly stdinLease?: boolean;
  /* Deadline после получения запроса, 1..2147483647 мс; null допустим для stdinLease. */
  readonly timeoutMs: number | null;
  /* Общий бюджет накапливаемых stdout/stderr в байтах, целое число 0..134217728. */
  readonly maxOutputBytes: number;
  /* Дополнительный лимит каждого накапливаемого потока; по умолчанию общий бюджет. */
  readonly maxOutputBytesPerStream?: number;
  /* Отвергает невалидный UTF-8 stdout до успешного ответа; байты результата не преобразует. */
  readonly strictStdout?: boolean;
  /* Передаёт stdout кусками вместо накопления; общий объём журнала не ограничен, очередь ограничена. */
  readonly stdout?: (chunk: Uint8Array) => void;
  /* Передаёт stderr кусками вместо накопления; отсутствие сохраняет ограниченную диагностику. */
  readonly stderr?: (chunk: Uint8Array) => void;
  /* Время для SIGINT/SIGTERM и EOF lease до принудительного cleanup, 0..10000 мс; по умолчанию 0. */
  readonly terminationGraceMs?: number;
  /* Отмена передаётся управляющим IPC; потеря владельца определяется EOF lease. */
  readonly signal?: AbortSignal;
}

/**
 * Результат самой команды; ненулевой code не является отказом guardian.
 */
export interface GuardedCommandResult {
  /* Exit code команды; при сигнале — 128 плюс номер сигнала. */
  readonly code: number;
  /* Исходные байты stdout, включая NUL и невалидный UTF-8; при streaming пуст. */
  readonly stdout: Uint8Array;
  /* stderr как UTF-8, при streaming пуст; редактирование секретов принадлежит вызывающему. */
  readonly stderr: string;
}

/**
 * Причины отказа инфраструктуры: deadline, отмена, общий бюджет, повреждённый протокол,
 * невозможность запуска, потеря guardian либо невозможность подтвердить очистку дерева.
 */
export type GuardedCommandFailureReason =
  "timeout" | "cancelled" | "output-limit" | "protocol" | "spawn" | "guardian" | "cleanup";

/**
 * Этап отказа запуска, проверяемый по закрытому набору значений private protocol.
 */
export type GuardedCommandFailureStage = (typeof guardianFailureStages)[number];

/**
 * Символ errno текущей ОС либо целый Win32-код 0..4294967295; произвольный текст недопустим.
 */
export type GuardedCommandSystemCode = keyof typeof constants.errno | number;

/**
 * Безопасная восстановленная причина native отказа без сообщения и параметров команды.
 */
export interface GuardedCommandDiagnostic {
  /* Этап запуска, установленный владельцем операции, а не взятый из сообщения native error. */
  readonly stage: GuardedCommandFailureStage;
  /* Исходный системный код; отсутствует, если native API не предоставил допустимого кода. */
  readonly systemCode?: GuardedCommandSystemCode;
}

/**
 * Ограниченная диагностика отказа; stdout/stderr могут быть неполными, этап может быть неизвестен.
 */
export interface GuardedCommandFailureDetails extends Partial<GuardedCommandDiagnostic> {
  /* Принятые до отказа байты stdout; отсутствие означает пустой поток. */
  readonly stdout?: Uint8Array;
  /* Принятый stderr; вызывающий отвечает за редактирование секретов. */
  readonly stderr?: string;
  /* Локальная причина; без неё известный stage восстанавливает безопасную диагностическую cause. */
  readonly cause?: unknown;
}
