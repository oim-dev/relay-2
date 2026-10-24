import { Database, constants } from "bun:sqlite";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

/**
 * Формирует диагностику реальной SQLite/companion-границы fixture, не открывая дополнительные соединения.
 */
function sqliteFixtureError(path: string, version: string, phase: string, mode: unknown): Error {
  const files = ["", "-wal", "-shm", "-journal"].map((suffix) => {
    const file = `${path}${suffix}`;
    if (!existsSync(file)) {
      return { suffix, exists: false };
    }
    const stat = statSync(file, { bigint: true });
    return {
      suffix,
      exists: true,
      bytes: String(stat.size),
      device: String(stat.dev),
      inode: String(stat.ino),
    };
  });
  return new Error(
    `Не подготовлено SQLite-состояние fixture: ${JSON.stringify({
      path,
      phase,
      mode,
      sqliteVersion: version,
      bun: Bun.version,
      platform: process.platform,
      files,
    })}`,
  );
}

/**
 * Готовит private DELETE-базу с инертным SHM из настоящей SQLite. На ОС, удаляющей индекс,
 * сохраняет его полученные bytes обратно эксклюзивной записью: воспроизводится наблюдённое
 * на macOS состояние, без замены SQL sealing заглушкой. Соединения закрывает; данные не меняет.
 * Вызывающий владеет всей fixture и обязан удалить её после теста. Живые соединения недопустимы.
 */
export function retainClosedFixtureShm(path: string): void {
  const connection = new Database(path, { create: false, readwrite: true });
  let shm: Buffer;
  let version = "unknown";
  try {
    version =
      connection.query<{ version: string }, []>("SELECT sqlite_version() AS version").get()
        ?.version ?? "unknown";
    const mode = connection.query<{ journal_mode: string }, []>("PRAGMA journal_mode=WAL").get();
    if (mode?.journal_mode !== "wal") {
      throw sqliteFixtureError(path, version, "enter-wal", mode);
    }
    // Bun требует 8-байтовый buffer для native fileControl, SQLite читает первое int32.
    const status = connection.fileControl(
      constants.SQLITE_FCNTL_PERSIST_WAL,
      new Int32Array([1, 0]),
    );
    if (status !== 0) {
      throw sqliteFixtureError(path, version, "persist-wal", status);
    }
    connection.query("SELECT * FROM project_state").get();
    shm = readFileSync(`${path}-shm`);
  } finally {
    connection.close(true);
  }
  const sealing = new Database(path, { create: false, readwrite: true });
  try {
    sealing.exec("PRAGMA busy_timeout=0; PRAGMA synchronous=FULL");
    const mode = sealing.query<{ journal_mode: string }, []>("PRAGMA journal_mode=DELETE").get();
    if (mode?.journal_mode !== "delete") {
      throw sqliteFixtureError(path, version, "seal-delete", mode);
    }
  } finally {
    sealing.close(true);
  }
  if (existsSync(`${path}-wal`) || existsSync(`${path}-journal`)) {
    throw sqliteFixtureError(path, version, "sealed-data-journals", "delete");
  }
  if (!existsSync(`${path}-shm`)) {
    writeFileSync(`${path}-shm`, shm, { flag: "wx", mode: 0o600 });
  }
}
