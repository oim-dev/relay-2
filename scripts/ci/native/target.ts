import { targets } from "../../verification/catalog";
import { ciMessages } from "../ci.messages";

/**
 * Запрещает исполнение native-команд и упаковку под именем другой ОС/архитектуры.
 * Portable относится только к JS/assets, проверки ОС выполняются на настоящем host target.
 */
export function requireHostTarget(id: string): void {
  if (id === "portable") {
    return;
  }
  const target = targets.find((entry) => entry.id === id);
  if (!target || target.platform !== process.platform || target.arch !== process.arch) {
    throw new Error(ciMessages.hostMismatch(id, process.platform, process.arch));
  }
}
