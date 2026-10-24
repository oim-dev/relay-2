import { spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import * as files from "node:fs";
import { join } from "node:path";
import { RelayError } from "@relay/contracts";
import { openProject, restoreProject } from "@relay/project-runtime";
import { ProjectDatabase } from "@relay/storage";

const cwd = process.env.RELAY_TEST_CWD;
const existingCwd = process.env.RELAY_TEST_EXISTING_CWD;
const home = process.env.RELAY_TEST_HOME;
const projectId = process.env.RELAY_TEST_PROJECT;
const mode = process.env.RELAY_TEST_PUBLICATION_FAILURE;
if (!cwd || !existingCwd || !home || !projectId || (mode !== "conflict" && mode !== "crash")) {
  throw new Error("Не задан изолированный контекст позднего writer restore");
}

/**
 * Принимает реальную CAS-запись через уже существующий config другого worktree.
 * Повторное открытие подтверждает commit; fixture явно завершает WAL через SQLite.
 */
function writeLateChange(existingCwd: string, home: string): void {
  const { location, database } = openProject({ cwd: existingCwd, home });
  try {
    const initial = database.get(location.projectId);
    if (!initial) {
      throw new Error("Не найден проект позднего writer");
    }
    database.update(
      {
        ...initial,
        revision: initial.revision + 1,
        updatedBy: "late-writer",
        updatedAt: new Date().toISOString(),
        data: { ...initial.data, name: "Принятая поздняя запись" },
      },
      initial.revision,
    );
  } finally {
    database.close();
  }
  const reopened = openProject({ cwd: existingCwd, home });
  try {
    const accepted = reopened.database.get(location.projectId);
    if (accepted?.revision !== 2 || accepted.data.name !== "Принятая поздняя запись") {
      throw new Error("Поздняя запись не сохранилась после reopen");
    }
  } finally {
    reopened.database.close();
  }
  // Условие регрессии — поздний commit после завершения WAL; остаточный SHM не содержит данных commit.
  // Других соединений в fixture уже нет; данные не удаляются файловыми операциями.
  const raw = new Database(location.databasePath, { create: false, readwrite: true });
  try {
    raw.exec("PRAGMA journal_mode=DELETE");
    if (
      raw.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode !==
      "delete"
    ) {
      throw new Error("Поздний writer не завершил WAL");
    }
  } finally {
    raw.close(true);
  }
  if (
    files.existsSync(`${location.databasePath}-wal`) ||
    files.existsSync(`${location.databasePath}-journal`)
  ) {
    throw new Error("Поздний writer не закрыл SQLite journals");
  }
}

if (process.argv.includes("--writer")) {
  writeLateChange(existingCwd, home);
  process.exit(0);
}

const databasePath = join(home, "projects", projectId, "project.sqlite");
const configPath = join(cwd, "relay.config.json");
const nativeLink = files.linkSync;
spyOn(files, "linkSync").mockImplementation((source, target) => {
  if (target !== configPath) {
    nativeLink(source, target);
    return;
  }
  // БД уже опубликована, SQLite-barrier закрыт; config ещё не опубликован.
  // Настоящий другой процесс принимает поздний commit до отказа/аварии привязки.
  const writer = spawnSync(process.execPath, [import.meta.filename, "--writer"], {
    cwd: existingCwd,
    env: process.env,
    encoding: "utf8",
    timeout: 5000,
  });
  if (writer.status !== 0 || writer.stdout || writer.stderr) {
    throw new Error(`Поздний writer отказал: ${writer.status}: ${writer.error ?? writer.stderr}`);
  }
  if (mode === "crash") {
    process.exit(73);
  }
  // Второй worktree публикует правильный config; никакой подмены inode или внешнего злоумышленника нет.
  files.writeFileSync(configPath, JSON.stringify({ version: 1, projectId, databasePath }), {
    flag: "wx",
  });
  nativeLink(source, target);
});

try {
  restoreProject({ cwd, home }, projectId, (path) => {
    const database = ProjectDatabase.create(path, {
      id: projectId,
      name: "Fetched snapshot",
      slug: "restored",
    });
    database.close();
  });
} catch (error) {
  if (mode !== "conflict" || !(error instanceof RelayError)) {
    throw error;
  }
  console.log(JSON.stringify({ code: error.code, details: error.details }));
  process.exit(0);
}
throw new Error("Restore не достиг ожидаемой границы отказа");
