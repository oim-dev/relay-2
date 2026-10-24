import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ProjectDatabase } from "@relay/storage";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { ReplicationService } from "../../src/replication/replication";
import { createReplicationFixture } from "../integration/helpers/replication-fixture";
import type { OwnedReplicationFixture } from "../integration/helpers/replication-fixture.types";

describe("Согласование пятидесяти реальных SQLite", () => {
  let fixture: OwnedReplicationFixture | undefined;
  let replicas: ProjectDatabase[] = [];

  /**
   * Закрывает и частично подготовленные соединения; afterEach повтор безопасен после setup failure.
   */
  function close(): void {
    try {
      for (const replica of replicas) {
        replica.close();
      }
    } finally {
      replicas = [];
      fixture?.close();
      fixture = undefined;
    }
  }

  beforeEach(async () => {
    fixture = await createReplicationFixture(() => {});
    try {
      // Только изолированный технический setup. Все offline мутации и 200 исходных assertions — в тесте.
      for (let index = 0; index < 50; index++) {
        const db = ProjectDatabase.createReplica(
          join(fixture.directory, `participant-${index}.sqlite`),
          fixture.first.projectId,
        );
        replicas.push(db);
        new ReplicationService(db).bootstrap(fixture.remote);
      }
    } catch (error) {
      close();
      throw error;
    }
  });

  afterEach(close);

  test("пятьдесят независимых предварительных назначений сходятся без потери ID и без echo", async () => {
    if (fixture === undefined) {
      throw new Error("Нет технической fixture");
    }
    let published = fixture.remote;
    const chain = [published];
    const ids: string[] = [];
    for (const [index, replica] of replicas.entries()) {
      ids.push(
        (
          await new KnowledgeService(replica).create(
            "document",
            { name: `Участник ${index}`, body: `Текст ${index}` },
            `actor-${index}`,
          )
        ).id,
      );
    }

    for (const replica of replicas) {
      const sync = new ReplicationService(replica);
      const prepared = sync.prepare(published, { chain });
      expect(prepared.conflicts).toEqual([]);
      published = prepared.snapshot;
      chain.push(published);
      sync.accept(published, { chain });
    }

    for (const replica of replicas) {
      const sync = new ReplicationService(replica);
      sync.accept(published, { chain });
      expect(
        replica
          .list("document")
          .map((record) => record.id)
          .sort(),
      ).toEqual([...ids].sort());
      expect(sync.prepare(published).snapshot).toEqual(published);
      expect(sync.status().pending).toBe(0);
    }
  });
});
