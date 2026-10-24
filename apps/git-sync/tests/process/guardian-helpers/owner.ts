import { readFileSync, writeFileSync } from "node:fs";
import { runGuardedCommand, GuardedCommandError } from "@relay/project-runtime";
import { ownerOptions } from "./wire";

const path = process.argv[2];
if (!path) {
  throw new Error("Не передан запрос процессной fixture");
}
const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
if (parsed === null || typeof parsed !== "object") {
  throw new Error("Повреждён запрос процессной fixture");
}
const request = ownerOptions(parsed);
try {
  const result = await runGuardedCommand({ ...request, input: new Uint8Array() });
  writeFileSync(`${path}.result`, JSON.stringify({ code: result.code }));
} catch (error) {
  writeFileSync(
    `${path}.result`,
    JSON.stringify({
      reason: error instanceof GuardedCommandError ? error.reason : "unexpected",
    }),
  );
}
