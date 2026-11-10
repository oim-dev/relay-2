import type { PortableProjectSnapshot } from "@relay/contracts";
import type { GitFiles } from "../transport/repository.types";
import { decodeSnapshotValue } from "../sync/replication-adapter";
import { decodeSnapshotData } from "./files";

export { encodeSnapshot, decodeSnapshotData } from "./files";

/**
 * Связывает layout 1/2 с единственным Core decoder DTO, не реконструируя nested source материал.
 * Старый layout и проверенный Markdown digest не заменяют предметную проверку snapshot/history.
 */
export function decodeSnapshot(
  files: GitFiles,
  expectedProjectId?: string,
): PortableProjectSnapshot {
  return decodeSnapshotValue(decodeSnapshotData(files, expectedProjectId));
}
