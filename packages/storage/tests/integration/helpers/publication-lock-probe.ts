import { Database } from "bun:sqlite";

const path = process.argv[2];
if (!path) {
  throw new Error("Не задан путь изолированной БД для writer probe");
}

// Отдельный процесс обходит SQLite VFS-cache родителя и наблюдает настоящую межпроцессную блокировку.
const database = new Database(path, { create: false, readwrite: true });
try {
  database.exec("PRAGMA busy_timeout=0");
  try {
    database.exec("BEGIN IMMEDIATE");
    console.log("ACQUIRED");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "SQLITE_BUSY")) {
      throw error;
    }
    console.log("SQLITE_BUSY");
  }
} finally {
  try {
    if (database.inTransaction) {
      database.exec("ROLLBACK");
    }
  } finally {
    database.close(true);
  }
}
