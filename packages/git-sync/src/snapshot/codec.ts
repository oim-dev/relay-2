import type { PortableProjectSnapshot } from "@relay/contracts";
import type { GitFiles } from "../transport/repository.types";
import { decodeSnapshotValue } from "../sync/replication-adapter";
import { decodeSnapshotData } from "./files";

export { encodeSnapshot, decodeSnapshotData } from "./files";

/**
 * Передаёт логическую проекцию табличного layout 3 единственному Core decoder DTO.
 * Физическая форма строк и соответствие PK не заменяют предметную проверку snapshot/history.
 */
export function decodeSnapshot(
  files: GitFiles,
  expectedProjectId?: string,
): PortableProjectSnapshot {
  return decodeSnapshotValue(decodeSnapshotData(files, expectedProjectId));
}
