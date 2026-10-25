import { on } from "node:events";
import { readFileSync } from "node:fs";
import { registerProject, unregisterProject } from "@relay/project-runtime";
import { readRegistrationInput, validateWorkspaceSnapshot } from "./helpers/worker-protocol";
import { workerMessages } from "./helpers/worker.messages";
import type { RegistrationCommand, RegistrationWorkerEvent } from "./helpers/worker.types";

const input = readRegistrationInput();

/**
 * Дожидается отправки фазы до блокирующего Runtime-вызова или закрытия IPC.
 * Подписка на команды остаётся активной до последнего callback отправки и подтверждения finish.
 */
function sendPhase(event: RegistrationWorkerEvent): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.send === undefined) {
      reject(new Error(workerMessages.ipcUnavailable));
      return;
    }
    process.send(event, (error: Error | null) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Принимает ровно ожидаемую команду; EOF и повтор старого go завершаются отказом до новой записи.
 */
async function expectCommand(
  messages: AsyncIterableIterator<unknown[]>,
  expected: RegistrationCommand,
): Promise<void> {
  const message = await messages.next();
  if (message.done) {
    throw new Error(workerMessages.coordinatorDisconnected);
  }
  const value: unknown = message.value[0];
  if (
    value === null ||
    typeof value !== "object" ||
    !("kind" in value) ||
    value.kind !== expected.kind ||
    (expected.kind === "go" && (!("index" in value) || value.index !== expected.index))
  ) {
    throw new Error(workerMessages.unexpectedCommand(expected, value));
  }
}

/**
 * Выполняет по одной реальной мутации на индексированный барьер, без повторов при отказе.
 */
async function changeRegistrations(messages: AsyncIterableIterator<unknown[]>): Promise<void> {
  for (let index = 0; index < input.count; index++) {
    await sendPhase({ phase: "ready", index });
    await expectCommand(messages, { kind: "go", index });
    await sendPhase({ phase: "started", index });
    const name = `${input.prefix}-${index}`;
    if (input.action === "register") {
      registerProject(input, name, input.target);
    } else {
      unregisterProject(input, name);
    }
    await sendPhase({ phase: "completed", index });
  }
  await sendPhase({ phase: "finished", count: input.count });
}

/**
 * Непрерывно проверяет JSON без mutex до stop; подтверждает первое чтение и убирает цикл также при EOF.
 */
async function readWorkspace(messages: AsyncIterableIterator<unknown[]>): Promise<void> {
  await sendPhase({ phase: "ready", index: 0 });
  await expectCommand(messages, { kind: "go", index: 0 });
  let snapshots = 0;
  let pending: ReturnType<typeof setImmediate> | undefined;
  /**
   * Проверяет целый снимок и планирует следующее чтение, не удерживая event loop синхронным циклом.
   */
  function readNextSnapshot(): void {
    const config: unknown = JSON.parse(readFileSync(input.config, "utf8"));
    validateWorkspaceSnapshot(config);
    snapshots++;
    pending = setImmediate(readNextSnapshot);
  }
  try {
    readNextSnapshot();
    await sendPhase({ phase: "reading" });
    await expectCommand(messages, { kind: "stop" });
  } finally {
    if (pending !== undefined) {
      clearImmediate(pending);
    }
  }
  await sendPhase({ phase: "stopped", snapshots });
}

// Очередь устанавливается до ready и остаётся подписанной до получения finish.
// Ранний go не теряется между await; разрыв IPC закрывает ожидающий итератор.
const messages: AsyncIterableIterator<unknown[]> = on(process, "message", {
  close: ["disconnect"],
});
try {
  if (input.action === "read") {
    await readWorkspace(messages);
  } else {
    await changeRegistrations(messages);
  }
  await expectCommand(messages, { kind: "finish" });
} finally {
  await messages.return?.();
  if (process.connected) {
    process.disconnect?.();
  }
}
