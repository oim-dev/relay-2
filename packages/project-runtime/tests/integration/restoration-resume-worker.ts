import { spyOn } from "bun:test";
import * as files from "node:fs";
import { join } from "node:path";
import { RelayError } from "@relay/contracts";
import { resumeProjectRestoration } from "@relay/project-runtime";
import { ProjectDatabase } from "@relay/storage";

const cwd = process.env.RELAY_TEST_CWD;
const home = process.env.RELAY_TEST_HOME;
const projectId = process.env.RELAY_TEST_PROJECT;
if (!cwd || !home || !projectId) {
  throw new Error("Не задан контекст fixture отказа resume");
}
const configPath = join(cwd, "relay.config.json");
const databasePath = join(home, "projects", projectId, "project.sqlite");
const nativeLink = files.linkSync;
spyOn(files, "linkSync").mockImplementation((source, target) => {
  nativeLink(source, target);
  if (target !== configPath) {
    return;
  }
  // Fault injection: после публикации config путь БД занимает другая валидная реплика того же ID.
  files.rmSync(databasePath);
  const foreign = ProjectDatabase.create(databasePath, {
    id: projectId,
    name: "Подмена после привязки",
    slug: "foreign",
  });
  foreign.close();
});
try {
  const result = resumeProjectRestoration({ cwd, home }, projectId, (path) => {
    const database = ProjectDatabase.open(path);
    try {
      if (database.projectId !== projectId) {
        throw new Error("Неверный ID fixture");
      }
    } finally {
      database.close();
    }
  });
  console.log(JSON.stringify(result));
} catch (error) {
  if (!(error instanceof RelayError)) {
    throw error;
  }
  console.log(JSON.stringify({ code: error.code }));
}
