import type { EntityRecord } from "@relay/contracts";
import type { ComponentWriteOptions } from "../components/component-store.types";

/**
 * Дополнительное основание exact command effect при обновлении typed владельца.
 */
export interface EntityUpdateOptions extends ComponentWriteOptions {
  /* Проверенный Core before из той же command boundary; без него читается текущая raw-проекция. */
  readonly before?: EntityRecord;
}
