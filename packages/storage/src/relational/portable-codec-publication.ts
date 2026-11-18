import {
  assertReplicationPublicationShape,
  RelayError,
  type ReplicationPublication,
} from "@relay/contracts";
import { invalidRow } from "./columns";
import { portableJson } from "./portable-codec-values";
import { relationalMessages } from "./relational.messages";

/**
 * Читает publication через общий shape decoder Contracts и сверяет его ID с физическим PK.
 * Core отдельно проверяет digest, причинность и эффекты; source, решения и receipts не пересобираются.
 * Ошибка формы преобразуется в CORRUPT_DATA с исходной причиной, неожиданные ошибки не маскируются.
 */
export function decodePortablePublication(id: string, payload: string): ReplicationPublication {
  const value = portableJson(payload, "payload_json");
  try {
    assertReplicationPublicationShape(value);
  } catch (cause) {
    if (!(cause instanceof RelayError) || cause.code !== "REPLICATION_FORMAT") {
      throw cause;
    }
    const error = new RelayError("CORRUPT_DATA", relationalMessages.shape, 1, {
      field: cause.details?.path ?? "publication",
    });
    error.cause = cause;
    throw error;
  }
  if (value.publicationId !== id) {
    invalidRow("publication.id");
  }
  return value;
}
