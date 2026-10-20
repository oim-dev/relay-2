import { readFileSync, readSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { RelayError } from "@relay/contracts";
import { withLocalFileLock } from "../../src";

const [path, mode, actor] = process.argv.slice(2) as [string, string, string];
const signal = (message: string) => writeSync(1, `${message}\n`);
function barrier(): void {
  if (readSync(0, Buffer.alloc(1), 0, 1, null) !== 1) throw new Error("Барьер закрыт без сигнала");
}

signal("ready");
barrier();
signal("attempting");
try {
  withLocalFileLock(path, () => {
    const content = JSON.parse(readFileSync(path, "utf8")) as { actors: string[] };
    signal("locked");
    // Барьер находится внутри синхронного callback: владелец удерживает настоящий SQLite mutex.
    if (mode === "hold") barrier();
    content.actors.push(actor);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(content));
    renameSync(temporary, path);
  });
  signal("done");
} catch (error) {
  if (!(error instanceof RelayError)) throw error;
  signal(JSON.stringify({ code: error.code, exitCode: error.exitCode }));
  process.exitCode = error.exitCode;
}
