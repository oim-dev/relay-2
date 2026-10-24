import { acquireLocalLock } from "../../../src/local-lock/local-lock";

const path = Bun.argv[2];
if (path === undefined) {
  throw new Error("Не передан путь mutex fixture");
}
const lock = acquireLocalLock(path);
try {
  process.stdout.write("locked\n");
  await Bun.stdin.text();
} finally {
  lock.release();
}
