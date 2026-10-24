import { runNativeProcess } from "@relay/project-runtime";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root) {
  throw new Error("Не передан каталог владельца lease");
}
const block = process.argv[3] === "block";
const marker = join(root, "owner-blocked");
await runNativeProcess({
  executable: process.execPath,
  args: [
    fileURLToPath(new URL("./process-guardian-actor.ts", import.meta.url)),
    block ? "lease-flood" : "lease",
    root,
  ],
  cwd: root,
  env: { ...process.env, HOME: root, USERPROFILE: root },
  timeoutMs: null,
  stdinLease: true,
  /**
   * Проксирует готовность, не закрывая stdin target до смерти владельца.
   */
  stdout(text): void {
    process.stdout.write(text);
    if (block) {
      writeFileSync(marker, "blocked");
      // Изолированный владелец намеренно перестаёт обслуживать IPC; тест убивает только его PID.
      for (;;) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
    }
  },
});
