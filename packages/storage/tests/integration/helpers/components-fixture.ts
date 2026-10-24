import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EntityRecord, TaskCriterion } from "@relay/contracts";
import { ProjectDatabase } from "../../../src/database/project-database";
import type { ComponentsFixture } from "./components-fixture.types";

/**
 * Создаёт собственный v4-проект и закрывает оба соединения до очистки каталога при любом исходе.
 */
export function withComponentsFixture(run: (fixture: ComponentsFixture) => void): void {
  const artifacts = resolve(
    import.meta.dir,
    "../../../../..",
    ".artifacts/2026-10-24/git-sync-implementation/normalization",
  );
  mkdirSync(artifacts, { recursive: true });
  const directory = mkdtempSync(join(artifacts, "fixture-"));
  let db: ProjectDatabase | undefined;
  let raw: Database | undefined;
  try {
    db = ProjectDatabase.create(join(directory, "project.sqlite"), {
      id: "project-components",
      name: "Части",
      slug: "components",
    });
    raw = new Database(db.path, { strict: true });
    run({ db, raw, directory });
  } finally {
    raw?.close();
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Создаёт точный критерий с данным scoped ID, без выдуманного авторства незавершённого критерия.
 */
export function componentCriterion(id: string, title = id): TaskCriterion {
  return {
    id,
    title,
    summary: "",
    description: `Текст ${id}`,
    completed: false,
    completedAt: null,
    completedBy: null,
  };
}

/**
 * Возвращает техническую полную карточку задачи с контролируемыми ID/metadata и заданными критериями.
 */
export function componentTask(
  id: string,
  key: string,
  criteria: readonly TaskCriterion[],
): EntityRecord {
  return {
    id,
    kind: "task",
    key,
    revision: 1,
    createdAt: "2026-10-20T12:00:00.000Z",
    updatedAt: "2026-10-20T12:00:00.000Z",
    createdBy: "original",
    updatedBy: "original",
    data: {
      title: id,
      description: `Описание ${id}`,
      boardId: "board",
      column: "inbox",
      parentId: null,
      dependencies: [],
      related: [],
      targets: [],
      acceptanceCriteria: [...criteria],
    },
  };
}
