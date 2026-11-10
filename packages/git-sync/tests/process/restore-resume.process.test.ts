import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KnowledgeService, ProjectDatabase, ReplicationService } from "@relay/core";
import { restoreProject } from "@relay/project-runtime";
import { RelayError } from "@relay/contracts";
import { withProcessFixture } from "./process-fixture";
import { restoreSnapshot } from "../../src/sync/replication-adapter";

describe("Явный resume сохранённой local restoration", () => {
  test("поздний commit сохраняется, resume не вызывает Git и не присваивает новый remote checkpoint", async () => {
    await withProcessFixture(async (fixture) => {
      const context = fixture.context("resume", false);
      const projectId = crypto.randomUUID();
      const source = ProjectDatabase.create(join(fixture.root, "source.sqlite"), {
        id: projectId,
        name: "resume",
        slug: "resume",
      });
      const snapshot = new ReplicationService(source).prepare(null).snapshot;
      source.close();
      const configPath = join(context.options.cwd, "relay.config.json");
      let databasePath: string | undefined;
      try {
        restoreProject(context.options, projectId, (path) => {
          restoreSnapshot(path, snapshot);
          // Занимаем только собственный fixture config после preflight, чтобы failure возник после link.
          mkdirSync(configPath);
        });
        throw new Error("expected recovery failure");
      } catch (error) {
        expect(error).toMatchObject({ code: "RESTORE_RECOVERY_REQUIRED" });
        if (!(error instanceof RelayError)) {
          throw error;
        }
        const location = error.details?.location;
        if (
          location &&
          typeof location === "object" &&
          "databasePath" in location &&
          typeof location.databasePath === "string"
        ) {
          databasePath = location.databasePath;
        } else if (typeof error.details?.databasePath === "string") {
          databasePath = error.details.databasePath;
        }
      }
      if (!databasePath) {
        throw new Error("recovery must report databasePath");
      }
      const database = ProjectDatabase.open(databasePath);
      const late = await new KnowledgeService(database).create(
        "document",
        { name: "Поздний commit", body: "сохранить без нового bootstrap" },
        "late-writer",
      );
      const before = new ReplicationService(database).status();
      database.close();
      const inode = statSync(databasePath, { bigint: true }).ino;
      rmdirSync(configPath);
      const shim = join(fixture.root, "resume-git-trap");
      mkdirSync(shim);
      const marker = join(fixture.root, "unexpected-resume-git");
      writeFileSync(join(shim, "git"), `#!/bin/sh\nprintf forbidden > '${marker}'\nexit 97\n`, {
        mode: 0o700,
      });

      const result = await fixture.request(
        context.options,
        "restore",
        { resume: true, projectId },
        { PATH: `${shim}:${process.env.PATH ?? ""}` },
      );

      expect(result).toMatchObject({
        ok: true,
        data: { resumed: true, preservedExisting: true, sourceCheckpoint: null, projectId },
      });
      expect(existsSync(marker)).toBe(false);
      expect(statSync(databasePath, { bigint: true }).ino).toBe(inode);
      const resumed = ProjectDatabase.open(databasePath);
      try {
        expect(resumed.get(late.id)?.data.body).toBe("сохранить без нового bootstrap");
        expect(new ReplicationService(resumed).status()).toEqual(before);
      } finally {
        resumed.close();
      }
      expect(
        await fixture.request(context.options, "restore", {
          resume: true,
          projectId,
          remote: fixture.remote,
        }),
      ).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
    });
  }, 20_000);
});
