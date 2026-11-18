import type {
  PortableBatchReceipt,
  PortableComment,
  ReplicationAcceptanceProof,
  ReplicationConfirmation,
} from "@relay/contracts";
import { decodeText, identityText, invalidRow, rowObject } from "./columns";
import type { SqlRow } from "./columns.types";
import {
  exactFields,
  portableArray,
  portableId,
  portableInteger,
  portableJson,
  portableVersion,
} from "./portable-codec-values";

/**
 * Собирает комментарий из единственного carrier текста, не перенося локальный sequence.
 */
export function decodePortableComment(row: Readonly<SqlRow>): PortableComment {
  return {
    taskId: portableId(row.task_id, "task_id"),
    after: row.after_id === null ? null : portableId(row.after_id, "after_id"),
    comment: {
      id: portableId(row.id, "id"),
      title: decodeText(row, "title") ?? invalidRow("title"),
      body: decodeText(row, "body") ?? invalidRow("body"),
      createdAt: identityText(row.created_at, "created_at"),
      createdBy: identityText(row.created_by, "created_by"),
    },
  };
}

/**
 * Проверяет JSON-контейнер квитанции и возвращает исходные строки побайтно.
 * Предметный результат и исторические ревизии внутри строк принадлежат Core.
 */
export function decodePortableReceipt(row: Readonly<SqlRow>): PortableBatchReceipt {
  portableJson(row.request_json, "request_json");
  portableJson(row.result_json, "result_json");
  return {
    operationKey: portableId(row.operation_key, "operation_key"),
    requestJson: identityText(row.request_json, "request_json"),
    resultJson: identityText(row.result_json, "result_json"),
  };
}

/**
 * Декодирует компактное подтверждение, различая отсутствие proofs и пустой массив.
 */
export function decodePortableConfirmation(row: Readonly<SqlRow>): ReplicationConfirmation {
  const ranges = portableArray(portableJson(row.ranges_json, "ranges_json"), "ranges").map(
    (entry): readonly [number, number] => {
      const range = portableArray(entry, "range");
      if (range.length !== 2) {
        invalidRow("range");
      }
      const start = portableInteger(range[0], "range.start", 1);
      const end = portableInteger(range[1], "range.end", start);
      return [start, end];
    },
  );
  let previous = -1;
  for (const [start, end] of ranges) {
    if (start <= previous + 1) {
      invalidRow("ranges");
    }
    previous = end;
  }
  const replicaId = portableId(row.replica_id, "replica_id");
  if (row.proofs_json === null) {
    return { replicaId, ranges };
  }
  const proofs = portableArray(portableJson(row.proofs_json, "proofs_json"), "proofs").map(
    decodeAcceptanceProof,
  );
  const sequences = new Set<number>();
  for (const proof of proofs) {
    if (sequences.has(proof.sequence)) {
      invalidRow("proof.sequence");
    }
    sequences.add(proof.sequence);
  }
  return { replicaId, ranges, proofs };
}

/**
 * Проверяет закрытую техническую форму proof, сохраняя optional-поля без подстановки.
 */
function decodeAcceptanceProof(value: unknown): ReplicationAcceptanceProof {
  const proof = rowObject(value, "proof");
  exactFields(
    proof,
    ["sequence", "digest"],
    ["publicationId", "resolutionId", "effectDigest", "outcome"],
  );
  if (
    Object.hasOwn(proof, "outcome") &&
    proof.outcome !== "applied" &&
    proof.outcome !== "discarded"
  ) {
    invalidRow("proof.outcome");
  }
  return {
    sequence: portableInteger(proof.sequence, "proof.sequence", 1),
    digest: portableVersion(proof.digest, "proof.digest"),
    ...(Object.hasOwn(proof, "publicationId")
      ? {
          publicationId: portableVersion(proof.publicationId, "proof.publicationId"),
        }
      : {}),
    ...(Object.hasOwn(proof, "resolutionId")
      ? {
          resolutionId:
            proof.resolutionId === null
              ? null
              : portableVersion(proof.resolutionId, "proof.resolutionId"),
        }
      : {}),
    ...(Object.hasOwn(proof, "effectDigest")
      ? {
          effectDigest: portableVersion(proof.effectDigest, "proof.effectDigest"),
        }
      : {}),
    ...(proof.outcome === "applied" || proof.outcome === "discarded"
      ? { outcome: proof.outcome }
      : {}),
  };
}
