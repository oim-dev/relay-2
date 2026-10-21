import type { EntityKind } from "./identity";

export { ENTITY_KINDS, isEntityKind, validateActor, type EntityKind } from "./identity";
export * from "./knowledge";
export * from "./tasks";
export * from "./planning";
export * from "./history";
export * from "./pagination";
export * from "./records";

export interface EntityRecord {
  id: string;
  kind: EntityKind;
  key: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
  data: Record<string, unknown>;
}

/** Идентичность разрешённой ссылки без содержания сущности и журнала комментариев. */
export type EntityIdentity = Pick<EntityRecord, "id" | "kind" | "key">;

export interface WriteOptions {
  actor: string;
  ifRevision: number;
}

export class RelayError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, exitCode = 1, details?: Record<string, unknown>) {
    super(message);
    this.name = "RelayError";
    this.code = code;
    this.exitCode = exitCode;
    if (details !== undefined) this.details = details;
  }
}
