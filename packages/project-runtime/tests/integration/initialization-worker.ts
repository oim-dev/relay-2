import { homedir } from "node:os";
import { RelayError } from "@relay/contracts";
import { initializeProject } from "../../src";
import type { RuntimeOptions } from "../../src";

const input = JSON.parse(process.argv[2]!) as RuntimeOptions & { expectedHome?: string };

// Проверяем изоляцию до init, чтобы тест default home никогда не записал
// данные в настоящий пользовательский каталог при смене поведения runtime.
if (input.expectedHome !== undefined && homedir() !== input.expectedHome) {
  throw new Error("Процесс проверки не изолировал домашний каталог");
}

process.on("message", (message) => {
  if (message !== "go") return;
  try {
    console.log(JSON.stringify({ location: initializeProject(input) }));
  } catch (error) {
    if (!(error instanceof RelayError)) throw error;
    console.log(JSON.stringify({ code: error.code }));
  } finally {
    process.disconnect?.();
  }
});
process.send?.("ready");
