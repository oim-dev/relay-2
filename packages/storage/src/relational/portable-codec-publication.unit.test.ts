import { describe, expect, test } from "bun:test";
import type { ReplicationPublication } from "@relay/contracts";
import { decodePortablePublication } from "./portable-codec-publication";

const publicationId = "a".repeat(64);

describe("Адаптер строки publication к общей форме", () => {
  test("shape не подменяет Core: пустая лента декодируется без доказательства публикации", () => {
    const publication: ReplicationPublication = {
      formatVersion: 1,
      publicationId,
      parent: null,
      snapshotDigest: "b".repeat(64),
      accepted: [],
      changes: [],
    };

    const decoded = decodePortablePublication(publicationId, JSON.stringify(publication));

    expect(decoded).toEqual(publication);
  });

  test("отказ Contracts сохраняется причиной CORRUPT_DATA вместо unchecked typed return", () => {
    const corrupted = JSON.stringify({
      formatVersion: 1,
      publicationId,
      parent: null,
      snapshotDigest: "b".repeat(64),
      accepted: [],
      changes: [{ source: {}, resolution: null, transitions: [] }],
    });

    expect(() => decodePortablePublication(publicationId, corrupted)).toThrow(
      expect.objectContaining({
        code: "CORRUPT_DATA",
        cause: expect.objectContaining({ code: "REPLICATION_FORMAT" }),
      }),
    );
  });

  test("физический PK сверяется после общей формы", () => {
    const payload = JSON.stringify({
      formatVersion: 1,
      publicationId,
      parent: null,
      snapshotDigest: "b".repeat(64),
      accepted: [],
      changes: [],
    });

    expect(() => decodePortablePublication("c".repeat(64), payload)).toThrow(
      expect.objectContaining({ code: "CORRUPT_DATA", details: { field: "publication.id" } }),
    );
  });
});
