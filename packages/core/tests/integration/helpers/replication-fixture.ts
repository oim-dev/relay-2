import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { ProjectDatabase } from "@relay/storage";
import { ReplicationService } from "../../../src/replication/replication";
import type { ReplicationFixture, OwnedReplicationFixture } from "./replication-fixture.types";

/**
 * Создаёт две файловые SQLite из одной принятой версии и очищает их даже после отказа.
 * seed задаёт минимальный предметный состав до первой публикации, run выполняет проверяемый сценарий.
 */
export async function withReplicationFixture(
  seed: (db: ProjectDatabase) => void | Promise<void>,
  run: (fixture: ReplicationFixture) => void | Promise<void>,
): Promise<void> {
  const fixture = await createReplicationFixture(seed);
  try {
    await run(fixture);
  } finally {
    fixture.close();
  }
}

/**
 * Подготавливает две настоящие SQLite и передаёт владение caller; ошибка подготовки очищает весь ресурс.
 * Используется hooks только для технического setup; предметные мутации/утверждения остаются в самом тесте.
 */
export async function createReplicationFixture(
  seed: (db: ProjectDatabase) => void | Promise<void>,
): Promise<OwnedReplicationFixture> {
  const artifacts = resolve(
    import.meta.dir,
    "../../../../..",
    ".artifacts",
    new Date().toLocaleDateString("sv-SE"),
    "git-sync-implementation/publication",
  );
  mkdirSync(artifacts, { recursive: true });
  const directory = mkdtempSync(join(artifacts, "replicas-"));
  let first: ProjectDatabase | undefined;
  let second: ProjectDatabase | undefined;
  let closed = false;
  /**
   * Закрывает даже частично подготовленную fixture; повтор не затрагивает вновь появившиеся файлы.
   */
  function close(): void {
    if (closed) {
      return;
    }
    closed = true;
    try {
      second?.close();
    } finally {
      try {
        first?.close();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }
  try {
    first = ProjectDatabase.create(join(directory, "first.sqlite"), {
      id: "replicated-project",
      name: "Репликация",
      slug: "replication",
    });
    await seed(first);
    const service = new ReplicationService(first);
    const prepared = service.prepare(null);
    if (prepared.conflicts.length > 0) {
      throw new Error(JSON.stringify(prepared.conflicts));
    }
    const remote = prepared.snapshot;
    service.accept(remote);
    second = ProjectDatabase.createReplica(join(directory, "second.sqlite"), first.projectId);
    new ReplicationService(second).bootstrap(remote);
    return { first, second, remote, directory, close };
  } catch (error) {
    close();
    throw error;
  }
}
