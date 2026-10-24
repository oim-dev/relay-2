import { describe, expect, test } from "bun:test";
import { closeSync, existsSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { replaceLocalFile } from "@relay/project-runtime";
import { RuntimeFixture } from "./helpers/runtime-fixture";

describe("Атомарная замена локального файла Runtime", () => {
  test("публичный primitive сохраняет байты открытого читателя и потребляет подготовленный файл", async () => {
    const fixture = new RuntimeFixture(
      "git-sync-implementation/finalization/windows-runtime-files/fixtures",
    );
    try {
      const target = join(fixture.cwd, "локальный файл.bin");
      const temporary = join(fixture.cwd, ".подготовленный.tmp");
      const previous = Buffer.from([0x00, 0xff, 0x0a, 0x80]);
      const next = Buffer.from([0xff, 0x00, 0xfe, 0x0d, 0x0a]);
      writeFileSync(target, previous);
      writeFileSync(temporary, next);
      const reader = openSync(target, "r");
      try {
        replaceLocalFile(temporary, target);

        expect(readFileSync(reader)).toEqual(previous);
        expect(readFileSync(target)).toEqual(next);
        expect(existsSync(temporary)).toBe(false);
        expect(readdirSync(fixture.cwd)).toEqual(["локальный файл.bin"]);
      } finally {
        closeSync(reader);
      }
    } finally {
      await fixture.dispose();
    }
  });
});
