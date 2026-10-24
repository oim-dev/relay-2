import { spyOn } from "bun:test";
import * as files from "node:fs";
import { join } from "node:path";
import { restoreProject } from "@relay/project-runtime";
import { ProjectDatabase } from "@relay/storage";
import { RelayError } from "@relay/contracts";

const cwd = process.env.RELAY_TEST_CWD;
const home = process.env.RELAY_TEST_HOME;
const projectId = process.env.RELAY_TEST_PROJECT;
if (!cwd || !home || !projectId) {
  throw new Error("Не задан изолированный контекст restore worker");
}
const databasePath = join(home, "projects", projectId, "project.sqlite");
const configPath = join(cwd, "relay.config.json");
const publicationPath = join(home, "projects", projectId, ".restore-publication.json");
const afterConfig = process.env.RELAY_TEST_AFTER_CONFIG === "1";
const beforeDatabase = process.env.RELAY_TEST_BEFORE_DATABASE === "1";
const link = files.linkSync;
const replaceBeforeConfig = process.env.RELAY_TEST_REPLACE_ON_CONFIG_FAILURE === "1";
const occupyTarget = process.env.RELAY_TEST_OCCUPY_TARGET_AFTER_INTENT === "1";
let intentPublished = false;
spyOn(files, "linkSync").mockImplementation((source, target) => {
  if (replaceBeforeConfig && target === configPath) {
    files.rmSync(databasePath);
    const foreign = ProjectDatabase.create(databasePath, {
      id: "foreign-project",
      name: "Чужая рабочая база",
      slug: "foreign",
    });
    foreign.close();
    files.writeFileSync(
      target,
      JSON.stringify({ version: 1, projectId: "foreign-project", databasePath }),
    );
    // Публикация config проиграет гонку, но путь БД уже принадлежит другой попытке.
  }
  link(source, target);
  if (target === publicationPath) {
    intentPublished = true;
    if (occupyTarget) {
      ProjectDatabase.create(databasePath, {
        id: "foreign-project",
        name: "Победитель гонки",
        slug: "foreign",
      }).close();
    } else if (beforeDatabase) {
      process.exit(73);
    }
  }
  if (!replaceBeforeConfig && afterConfig && target === configPath) {
    process.exit(73);
  }
});
const stat = files.lstatSync;
/**
 * Сохраняет все overloads Node lstat и останавливает процесс после публикации datafile.
 * Assertion относится только к overloaded TS-сигнатуре: результат native stat не преобразуется.
 */
const faultingStat = ((path: files.PathLike, options?: files.StatOptions) => {
  const observed = stat(path, options);
  // Первый успешный stat public datafile после intent — проверка сразу после native publication.
  // process.exit не разворачивает finally: SQLite-handle ещё принадлежит publication barrier.
  if (
    intentPublished &&
    !beforeDatabase &&
    !afterConfig &&
    !replaceBeforeConfig &&
    !occupyTarget &&
    path === databasePath
  ) {
    process.exit(73);
  }
  return observed;
}) as typeof files.lstatSync;
spyOn(files, "lstatSync").mockImplementation(faultingStat);
try {
  restoreProject({ cwd, home }, projectId, (path) => {
    const database = ProjectDatabase.create(path, {
      id: projectId,
      name: "Прерванная копия",
      slug: "interrupted",
    });
    database.close();
  });
} catch (error) {
  if ((!replaceBeforeConfig && !occupyTarget) || !(error instanceof RelayError)) {
    throw error;
  }
  console.log(JSON.stringify({ code: error.code }));
  process.exit(0);
}
throw new Error("Worker не остановился на границе публикации");
