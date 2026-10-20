export type EntityKind =
  | "project"
  | "product"
  | "feature"
  | "scenario"
  | "application"
  | "implementation"
  | "board"
  | "task"
  | "document"
  | "work-plan"
  | "release"
  | "work-session"
  | "work-checkpoint";

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
