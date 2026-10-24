import type { Database } from "bun:sqlite";
import type { ComponentWriteOptions } from "./component-store.types";
import { assertSqlText } from "../entities/entity-sql-text";

/**
 * Удерживает заранее выделенный effect ID для нормализатора и SQL address triggers.
 * Вызывающий уже владеет синхронной transaction; вложенный контекст возвращается даже при отказе.
 */
export function withComponentAllocation<T>(
  connection: Database,
  options: ComponentWriteOptions,
  operation: () => T,
): T {
  if (options.allocationId === undefined) {
    return operation();
  }
  assertSqlText(options.allocationId, "allocationId");
  const previous =
    connection
      .query<{ id: string | null }, []>(
        "SELECT id FROM component_allocation_context WHERE singleton=1",
      )
      .get()?.id ?? null;
  connection
    .query("UPDATE component_allocation_context SET id=? WHERE singleton=1")
    .run(options.allocationId);
  try {
    return operation();
  } finally {
    if (connection.inTransaction) {
      connection
        .query("UPDATE component_allocation_context SET id=? WHERE singleton=1")
        .run(previous);
    }
  }
}
