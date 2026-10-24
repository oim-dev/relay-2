import { Database } from "bun:sqlite";
import { lstatSync } from "node:fs";
import { ProjectDatabase } from "../../../src/database/project-database";
import { RelayError } from "@relay/contracts";

const path = process.argv[2];
if (!path) {
  throw new Error("Не задан путь fixture конкурентного opener");
}
console.log("ready");
if ((await Bun.stdin.text()) !== "open\n") {
  throw new Error("Не получен stdin-barrier конкурентного opener");
}
let database: ProjectDatabase | undefined;
try {
  database = ProjectDatabase.open(path);
  const metadata = new Database(path, { readonly: true });
  let mode: unknown;
  try {
    mode = metadata.query("PRAGMA journal_mode").get();
  } finally {
    metadata.close();
  }
  const stat = lstatSync(path, { bigint: true });
  console.log(
    JSON.stringify({
      path: database.path,
      projectId: database.projectId,
      project: database.get(database.projectId),
      document: database.get("DOC-OPEN"),
      generation: database.getGeneration(),
      replicaId: database.getReplicationState().replicaId,
      outbox: database.getReplicationOutbox(),
      mode,
      physical: {
        device: String(stat.dev),
        inode: String(stat.ino),
        birthtimeNs: String(stat.birthtimeNs),
      },
    }),
  );
} catch (error) {
  if (!(error instanceof RelayError)) {
    throw error;
  }
  console.log(
    JSON.stringify({
      error: { code: error.code, exitCode: error.exitCode, message: error.message },
    }),
  );
  process.exitCode = error.exitCode;
} finally {
  database?.close();
}
