import { readFileSync } from "node:fs";
import { registerProject, unregisterProject } from "@relay/project-runtime";
import { readRegistrationInput, validateWorkspaceSnapshot } from "./helpers/worker-protocol";

const input = readRegistrationInput();

let index = 0;
let stopped = false;

/**
 * Непрерывно проверяет целостность JSON между оборотами event loop до явного stop.
 * Чтение идёт без mutex и способно обнаружить частично опубликованный файл.
 */
function readWorkspaceUntilStopped(): void {
  if (stopped) {
    return;
  }
  const config: unknown = JSON.parse(readFileSync(input.config, "utf8"));
  validateWorkspaceSnapshot(config);
  setImmediate(readWorkspaceUntilStopped);
}

/**
 * Выполняет ровно одну запись после барьера и сообщает готовность к следующей операции.
 */
function changeNextRegistration(): void {
  const name = `${input.prefix}-${index}`;
  if (input.action === "register") {
    registerProject(input, name, input.target);
  } else {
    unregisterProject(input, name);
  }
  index++;
  if (index === input.count) {
    process.disconnect?.();
  } else {
    process.send?.("ready");
  }
}

/**
 * Обрабатывает команды координатора: запуск чтения, одну запись либо остановку читателя.
 */
function receiveCoordinatorMessage(message: unknown): void {
  if (message === "stop") {
    stopped = true;
    process.disconnect?.();
    return;
  }
  if (message !== "go") {
    return;
  }
  if (input.action === "read") {
    readWorkspaceUntilStopped();
    return;
  }
  changeNextRegistration();
}

process.on("message", receiveCoordinatorMessage);
process.send?.("ready");
