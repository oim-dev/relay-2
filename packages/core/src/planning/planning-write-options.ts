import { validateActor, type CommandWriteOptions } from "@relay/contracts";
import { batchText } from "../batch/batch-input";
import { expectedCommandVersion } from "../commands/command-write";
import { object, revision } from "./planning-validation";
import type { PlanTransferWriteOptions } from "./planning.types";

/**
 * Проверяет условия исходного владельца без I/O: явный token имеет приоритет над
 * constructor default, numeric CAS не создаётся при version-only вводе.
 */
function sourceConditions(
  options: Readonly<CommandWriteOptions>,
  inheritedVersion?: string,
): CommandWriteOptions {
  const expectedVersion = expectedCommandVersion(options.expectedVersion, inheritedVersion);
  const ifRevision =
    options.ifRevision !== undefined || expectedVersion === undefined
      ? revision(options.ifRevision)
      : undefined;
  return {
    actor: validateActor(options.actor),
    ...(ifRevision === undefined ? {} : { ifRevision }),
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
  };
}

/**
 * Сохраняет legacy shape/error codes писателя и принимает альтернативный token агрегата.
 * Неизвестные поля запрещены, undefined optional условий не попадает в NamedCommand.
 */
export function parsePlanningWriteOptions(
  options: Readonly<CommandWriteOptions>,
  inheritedVersion?: string,
): CommandWriteOptions {
  object(options, ["actor", "ifRevision", "expectedVersion"], ["ifRevision", "expectedVersion"]);
  return sourceConditions(options, inheritedVersion);
}

/**
 * Проверяет независимые условия получателя: хотя бы одно обязательно; неверный numeric
 * CAS не игнорируется при наличии token. Constructor default относится только к источнику.
 */
export function parsePlanningTransferWriteOptions(
  options: PlanTransferWriteOptions,
  inheritedVersion?: string,
): PlanTransferWriteOptions {
  object(
    options,
    ["actor", "ifRevision", "expectedVersion", "targetRevision", "targetVersion"],
    ["ifRevision", "expectedVersion", "targetRevision", "targetVersion"],
  );
  const source = sourceConditions(options, inheritedVersion);
  const targetVersion =
    options.targetVersion === undefined
      ? undefined
      : batchText(options.targetVersion, "options.targetVersion");
  const targetRevision =
    options.targetRevision !== undefined || targetVersion === undefined
      ? revision(options.targetRevision)
      : undefined;
  return {
    ...source,
    ...(targetRevision === undefined ? {} : { targetRevision }),
    ...(targetVersion === undefined ? {} : { targetVersion }),
  };
}
