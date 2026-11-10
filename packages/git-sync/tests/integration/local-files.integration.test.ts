import { describe, expect, test } from "bun:test";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readLocalJson, writeLocalJson } from "../../src/local/files";

describe("Локальные JSON-файлы Git Sync", () => {
  test("новая публикация сохраняет прежний JSON открытого читателя и убирает свой temp", () => {
    const artifacts = resolve(
      import.meta.dir,
      "../../../../.artifacts",
      new Date().toISOString().slice(0, 10),
      "git-sync-implementation/finalization/windows-runtime-files/fixtures",
    );
    mkdirSync(artifacts, { recursive: true });
    const root = mkdtempSync(join(artifacts, "local-json-"));
    try {
      const path = join(root, "локальное состояние", "progress.json");
      writeLocalJson(path, { phase: "idle", afterSequence: 7, next: null });
      const reader = openSync(path, "r");
      try {
        writeLocalJson(path, { phase: "fetching", afterSequence: 9, next: "обмен" });

        expect(readFileSync(reader, "utf8")).toBe(
          '{"phase":"idle","afterSequence":7,"next":null}\n',
        );
        expect(readFileSync(path, "utf8")).toBe(
          '{"phase":"fetching","afterSequence":9,"next":"обмен"}\n',
        );
        expect(readLocalJson(path)).toEqual({ phase: "fetching", afterSequence: 9, next: "обмен" });
        expect(readdirSync(dirname(path))).toEqual(["progress.json"]);
      } finally {
        closeSync(reader);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
