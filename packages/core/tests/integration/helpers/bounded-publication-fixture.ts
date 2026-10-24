import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { ProjectDatabase } from "@relay/storage";
import { ReplicationService } from "../../../src/replication/replication";
import type { ReplicationFixture } from "./replication-fixture.types";

/**
 * Владеет двумя маленькими файловыми SQLite и их genesis; seed не превышает обычный бюджет.
 * Сценарии bounded publication сохраняют временные данные в своей области артефактов и очищают её.
 */
export async function withBoundedPublicationFixture(
  seed: (db: ProjectDatabase) => void | Promise<void>,
  run: (fixture: ReplicationFixture) => void | Promise<void>,
): Promise<void> {
  const root = resolve(
    import.meta.dir,
    "../../../../..",
    ".artifacts",
    new Date().toLocaleDateString("sv-SE"),
    "git-sync-implementation/finalization/bounded-publication",
  );
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "sqlite-"));
  let first: ProjectDatabase | undefined;
  let second: ProjectDatabase | undefined;
  try {
    first = ProjectDatabase.create(join(directory, "first.sqlite"), {
      id: "bounded-publication",
      name: "Ограниченная публикация",
      slug: "bounded",
    });
    await seed(first);
    const writer = new ReplicationService(first);
    const initial = writer.prepare(null);
    if (initial.conflicts.length > 0 || initial.selection.hasMore) {
      throw new Error("Неверный genesis маленькой fixture");
    }
    writer.accept(initial.snapshot);
    second = ProjectDatabase.createReplica(join(directory, "second.sqlite"), first.projectId);
    new ReplicationService(second).bootstrap(initial.snapshot);
    await run({ first, second, remote: initial.snapshot, directory });
  } finally {
    try {
      second?.close();
    } finally {
      first?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
}
