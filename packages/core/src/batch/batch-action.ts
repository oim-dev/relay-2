import type { BatchAction, BatchActionOptions } from "./batch.types";
import type { BatchStepContext } from "./batch-context";

/**
 * Связывает описание поля с его единственным предметным исполнителем и публичной справкой.
 */
export function batchAction(
  op: string,
  inputFields: readonly string[],
  options: BatchActionOptions,
  execute: BatchAction<BatchStepContext>["execute"],
): BatchAction<BatchStepContext> {
  const addresses = (options.addresses ?? []).filter((field) =>
    inputFields.includes(field.path.split(".")[0] ?? ""),
  );
  return {
    description: {
      op,
      inputFields,
      description: options.description,
      ref: options.ref ? "required" : "none",
      revisionOwner: options.revisionOwner ?? null,
      referenceFields: addresses.map((field) => field.path),
    },
    addresses,
    execute,
  };
}
