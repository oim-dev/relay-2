import { RelayError, type EntityKind } from "@relay/contracts";
import { entityMessages } from "../entities/entity.messages";
import type { KnowledgeAddressObservation } from "./knowledge-command.types";

/**
 * Проверяет загруженные адресные предикаты без I/O; прежний собственный алиас допустим.
 * Ключ/ID глобальны, виртуальные адреса не запрещают собственную пару application + board.
 */
export function requireKnowledgeAddresses(
  kind: EntityKind,
  id: string,
  observations: readonly KnowledgeAddressObservation[],
): void {
  for (const observation of observations) {
    const direct = observation.direct;
    const owner =
      direct !== null &&
      direct.id !== id &&
      (observation.scope === "global" || direct.kind === kind)
        ? direct
        : observation.virtual.find((entry) => entry.id !== id);
    if (owner !== undefined) {
      throw new RelayError("CONFLICT", entityMessages.occupiedAddress(observation.ref), 4, {
        kind,
        ref: observation.ref,
        owner,
      });
    }
  }
}
