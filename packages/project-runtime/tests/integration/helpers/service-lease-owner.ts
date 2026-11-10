import { acquireLocalLock } from "@relay/storage";

// Независимый владелец lifetime lease без endpoint: исчезновение readiness не означает освобождение mutex.
const path = process.argv[2];
if (!path) {
  throw new Error("Нужен изолированный путь lifetime mutex");
}
const lock = acquireLocalLock(path);
try {
  process.stdout.write("ready\n");
  await Bun.stdin.text();
} finally {
  lock.release();
}
