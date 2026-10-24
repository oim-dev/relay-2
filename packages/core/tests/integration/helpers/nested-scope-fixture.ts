import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  componentIdentity,
  type PortableComponent,
  type ReplicationChangeset,
} from "@relay/contracts";
import { ProjectDatabase } from "@relay/storage";
import { ReplicationService } from "../../../src/replication/replication";
import { versionComponent } from "../../../src/replication/component-merge";
import type { ReplicationFixture } from "./replication-fixture.types";
import { redigestSource } from "./replication-publication-fixture";

/**
 * Создаёт две изолированные SQLite с общей принятой основой; всегда закрывает и удаляет fixture.
 * Материалы адресной регрессии принадлежат каталогу nested-scope, пользовательские БД не используются.
 */
export async function withNestedScopeFixture(
  seed: (db: ProjectDatabase) => Promise<void>,
  run: (fixture: ReplicationFixture) => Promise<void>,
): Promise<void> {
  const artifacts = resolve(
    import.meta.dir,
    "../../../../..",
    ".artifacts",
    new Date().toLocaleDateString("sv-SE"),
    "git-sync-implementation/finalization/nested-scope",
  );
  mkdirSync(artifacts, { recursive: true });
  const directory = mkdtempSync(join(artifacts, "replicas-"));
  let first: ProjectDatabase | undefined;
  let second: ProjectDatabase | undefined;
  try {
    first = ProjectDatabase.create(join(directory, "first.sqlite"), {
      id: "nested-scope-project",
      name: "Область вложенной команды",
      slug: "nested-scope",
    });
    await seed(first);
    const sync = new ReplicationService(first);
    const prepared = sync.prepare(null);
    if (prepared.conflicts.length > 0) {
      throw new Error(JSON.stringify(prepared.conflicts));
    }
    sync.accept(prepared.snapshot);
    second = ProjectDatabase.createReplica(join(directory, "second.sqlite"), first.projectId);
    new ReplicationService(second).bootstrap(prepared.snapshot);
    await run({ first, second, remote: prepared.snapshot, directory });
  } finally {
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
}

/**
 * Требует единственный исходный changeset команды с сохранёнными targets и ordered tape.
 */
export function nestedScopeSource(db: ProjectDatabase): ReplicationChangeset {
  const sources = db.getReplicationOutbox();
  const source = sources[0];
  if (sources.length !== 1 || source?.transitions === undefined) {
    throw new Error("Ожидалась одна именованная команда в outbox");
  }
  return source;
}

/**
 * Заменяет эффект A правдоподобной правкой B того же владельца. Targets, guard и receipt A
 * сохраняются; причинная версия B и все source hashes согласованы, чтобы проверялся semantic scope.
 */
export function replaceNestedTextEffect(
  source: ReplicationChangeset,
  selectedId: string,
  other: PortableComponent<"plan-stage" | "document-section">,
): ReplicationChangeset {
  if (source.components === undefined || source.transitions === undefined) {
    throw new Error("Нет нормализованной ленты исходной команды");
  }
  const original = source.components.find(
    (entry) => entry.after.kind === other.kind && entry.after.id === selectedId,
  );
  if (original === undefined) {
    throw new Error("Нет исходного вложенного эффекта A");
  }
  const edited =
    other.kind === "plan-stage"
      ? { ...other, value: { ...other.value, title: "Подмена B" } }
      : { ...other, value: { ...other.value, name: "Подмена B" } };
  const replacement = {
    key: componentIdentity(other),
    before: other,
    after: versionComponent(edited, [other.version]),
  };
  return redigestSource({
    ...source,
    components: source.components.map((entry) =>
      entry.key === original.key ? replacement : entry,
    ),
    transitions: source.transitions.map((step) => ({
      ...step,
      components: step.components.map((entry) =>
        entry.key === original.key ? replacement : entry,
      ),
    })),
  });
}
