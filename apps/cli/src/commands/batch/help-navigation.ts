import type { BatchOperationDescription } from "@relay/contracts";
import type { CommandRegistry } from "../../execution/registry";
import { batchCommandMessages as messages } from "../../locales/commands/batch";
import { createBatchOperationHelp, findBatchSubjectCommand } from "./help";

/**
 * Регистрирует только имена и краткие назначения узлов batch help по каталогу Core.
 * Корень и группы не читают аргументы, policy и примеры операций; листья вычисляются лениво.
 * Порядок разделов и действий следует каталогу. Dotted-имена остаются только именами JSON-операций.
 */
export function registerBatchHelp(
  registry: CommandRegistry,
  catalog: readonly BatchOperationDescription[],
): void {
  registry.groupLazy("batch help", messages.helpRoot.description, () => messages.helpRoot);
  const paths = new Set<string>();
  for (const operation of catalog) {
    const parts = operation.op.split(".");
    for (let size = 1; size <= parts.length; size++) {
      const path = parts.slice(0, size).join(" ");
      if (paths.has(path)) {
        continue;
      }
      paths.add(path);
      const subject = findBatchSubjectCommand(registry.commands, parts.slice(0, size).join("."));
      if (!subject.description?.trim()) {
        throw new Error(messages.helpMissingDescription(path));
      }
      const description = subject.description;
      if (size === parts.length) {
        registry.groupLazy(`batch help ${path}`, description, () =>
          createBatchOperationHelp(operation, registry.commands),
        );
      } else {
        const child = parts[size];
        if (!child) {
          throw new Error(messages.helpMissingCommand(path));
        }
        registry.groupLazy(`batch help ${path}`, description, () =>
          messages.helpGroup(path, description, child),
        );
      }
    }
  }
}
