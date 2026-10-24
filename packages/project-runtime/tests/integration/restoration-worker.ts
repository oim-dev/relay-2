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
const stopAfter =
  process.env.RELAY_TEST_AFTER_CONFIG === "1"
    ? join(cwd, "relay.config.json")
    : join(home, "projects", projectId, "project.sqlite");
const link = files.linkSync;
const replaceBeforeConfig = process.env.RELAY_TEST_REPLACE_ON_CONFIG_FAILURE === "1";
spyOn(files, "linkSync").mockImplementation((source, target) => {
  if (
    process.env.RELAY_TEST_BEFORE_DATABASE === "1" &&
    target === join(home, "projects", projectId, "project.sqlite")
  ) {
    // Intent уже опубликован, но неизвестно, увидел бы следующий процесс рабочую БД до аварии.
    process.exit(73);
  }
  if (replaceBeforeConfig && target === join(cwd, "relay.config.json")) {
    const databasePath = join(home, "projects", projectId, "project.sqlite");
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
  // process.exit не разворачивает finally Runtime: воспроизводится реальная незавершённая публикация.
  if (!replaceBeforeConfig && target === stopAfter) {
    process.exit(73);
  }
});
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
  if (!replaceBeforeConfig || !(error instanceof RelayError)) {
    throw error;
  }
  console.log(JSON.stringify({ code: error.code }));
  process.exit(0);
}
throw new Error("Worker не остановился на границе публикации");
