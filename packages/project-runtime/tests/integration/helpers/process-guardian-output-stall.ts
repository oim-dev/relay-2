import { runGuardianEntry } from "@relay/project-runtime";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
const send = process.send;
if (!root || !send) {
  throw new Error("Не переданы каталог и IPC владельца процессной fixture");
}

/**
 * Задерживает завершение только streaming send в отдельном helper-процессе.
 * Настоящий IPC доставляет данные владельцу; callback остаётся pending даже после его смерти.
 * Control, stdin lease и production cleanup проходят через настоящий guardian.
 */
process.send = (message, ...args): boolean => {
  if (
    message !== null &&
    typeof message === "object" &&
    "kind" in message &&
    message.kind === "output"
  ) {
    writeFileSync(join(root, "output-callback-pending"), "pending");
    return send(message, () => {});
  }
  // Сохраняем перегрузки native send, включая положение callback и необязательные handles.
  return Reflect.apply(send, process, [message, ...args]);
};

process.exit(await runGuardianEntry());
