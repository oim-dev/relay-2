import type { GuardedCommandDiagnostic, GuardedCommandFailureReason } from "./guardian.types";

/**
 * Единственный запрос length-prefixed JSON; после него stdin остаётся lease владельца.
 */
export interface GuardianRequest {
  /* Версия приватного протокола, изменяемая согласованно внутри одного бинарника. */
  readonly version: 1;
  /* Guardian управляет деревом, anchor удерживает корень дерева до его очистки. */
  readonly role: "guardian" | "anchor";
  /* Команда приложения для запуска якоря того же выпуска. */
  readonly component: readonly string[];
  /* Команда, аргументы которой не интерпретируются оболочкой. */
  readonly argv: readonly string[];
  /* Рабочий каталог команды. */
  readonly cwd: string;
  /* Полное окружение без undefined, удалённых при сериализации. */
  readonly env: Readonly<Record<string, string>>;
  /* Канонический base64 полного stdin команды. */
  readonly input: string;
  /* Deadline в миллисекундах. */
  readonly timeoutMs: number | null;
  /* Общий бюджет накапливаемых выходных потоков в байтах. */
  readonly maxOutputBytes: number;
  /* Отдельный бюджет каждого накапливаемого потока. */
  readonly maxOutputBytesPerStream: number;
  /* Оставляет stdin команды открытым до управляющей остановки. */
  readonly stdinLease: boolean;
  /* Проверяет UTF-8 stdout до успешного завершения. */
  readonly strictStdout: boolean;
  /* Передаёт stdout через ограниченный IPC вместо накопления. */
  readonly streamStdout: boolean;
  /* Передаёт stderr через ограниченный IPC вместо накопления. */
  readonly streamStderr: boolean;
  /* Предельная длительность graceful-фазы перед force cleanup. */
  readonly terminationGraceMs: number;
}

/**
 * Ограниченное потоковое сообщение guardian по отдельному служебному IPC.
 */
export interface GuardianOutput {
  /* Версия приватного протокола. */
  readonly version: 1;
  /* Потоковый вывод не является конечным ответом. */
  readonly kind: "output";
  /* Выходной поток исходной команды. */
  readonly stream: "stdout" | "stderr";
  /* Канонический base64 не более 64 KiB исходных байтов. */
  readonly data: string;
}

/**
 * Ограниченная остановка доверенной роли с различением сигнала и EOF владельца.
 */
export interface GuardianControl {
  /* Версия приватного протокола. */
  readonly version: 1;
  /* Просьба завершить команду с сохранением причины сигнала. */
  readonly kind: "stop";
  /* POSIX-сигнал graceful-фазы; Windows использует EOF stdin lease. */
  readonly signal: "SIGINT" | "SIGTERM";
  /* При потере родителя сначала только EOF lease, чтобы target различил stdin-eof и явный сигнал. */
  readonly stdinOnly?: boolean;
}

/**
 * Сериализованный результат команды, независимый от exit code guardian.
 */
export interface GuardianSuccess {
  /* Версия протокола. */
  readonly version: 1;
  /* Признак полученного результата самой команды. */
  readonly kind: "result";
  /* Exit code команды. */
  readonly code: number;
  /* Канонический base64 исходного stdout. */
  readonly stdout: string;
  /* Канонический base64 исходного stderr. */
  readonly stderr: string;
}

/**
 * Отказ инфраструктуры с ограниченными частичными потоками команды.
 */
export interface GuardianFailure extends Partial<GuardedCommandDiagnostic> {
  /* Версия протокола. */
  readonly version: 1;
  /* Признак инфраструктурного отказа. */
  readonly kind: "failure";
  /* Причина, проверяемая по закрытому перечислению. */
  readonly reason: GuardedCommandFailureReason;
  /* Канонический base64 частичного stdout. */
  readonly stdout: string;
  /* Канонический base64 частичного stderr. */
  readonly stderr: string;
}

/**
 * Ровно один конечный ответ guardian после очистки дерева.
 */
export type GuardianResponse = GuardianSuccess | GuardianFailure;

/**
 * Сообщение якоря о выходе непосредственной команды, а не о закрытии её потомков.
 */
export type AnchorOutcome =
  | Pick<GuardianSuccess, "version" | "kind" | "code">
  | Pick<GuardianFailure, "version" | "kind" | "reason" | "stage" | "systemCode">;

/**
 * Прочитанный запрос и независимый от него сигнал конца владения процессом.
 */
export interface GuardianLease {
  /* Завершается после одного целого frame; лишние байты отменяют lease. */
  readonly request: Promise<unknown>;
  /* EOF означает cancelled, повреждённый поток означает protocol. */
  readonly signal: AbortSignal;
  /**
   * Снимает обработчики и закрывает входной поток после окончания роли.
   */
  dispose(): void;
}
