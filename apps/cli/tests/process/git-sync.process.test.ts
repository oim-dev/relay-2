import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { KnowledgeService } from "@relay/core";
import { initializeWorkspace, registerProject } from "@relay/project-runtime";
import { arrayValue, objectValue, stringValue } from "../integration/helpers/responses";
import {
  addProjectOrigin,
  makeProjectSyncDue,
  withGitSyncCli,
  withSyncDatabase,
} from "./git-sync-process";

const entrances = [
  { name: "публичная команда", wire: false },
  { name: "private wire", wire: true },
] as const;

/**
 * Извлекает argv фактически запущенных Git-процессов из штатного trace2, не подменяя транспорт.
 */
function gitCommands(path: string): readonly (readonly string[])[] {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .flatMap((line) => {
      const event = objectValue(JSON.parse(line));
      return event.event === "start" ? [arrayValue(event.argv).map(stringValue)] : [];
    });
}

describe("Git Sync внутри настоящего CLI", () => {
  test("connect сохраняет буквальный remote из argv и создаёт linked worktree без публикации", async () => {
    await withGitSyncCli(async (fixture) => {
      const pending = await withSyncDatabase(
        fixture.location,
        (db) => db.getReplicationStatus().pending,
      );

      const response = await fixture.invoke([
        "git-sync",
        "connect",
        "--remote",
        fixture.remote,
        "--branch",
        "relay-data",
        "--format",
        "json",
      ]);

      expect(response).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(response.stdout)).toMatchObject({
        ok: true,
        data: {
          projectId: fixture.location.projectId,
          connected: true,
          branch: "relay-data",
          pending: { changesets: pending },
        },
      });
      expect(await fixture.git(fixture.options.cwd, ["remote", "get-url", "origin"])).toBe(
        fixture.remote,
      );
      expect(
        await fixture.git(join(dirname(fixture.location.databasePath), "data"), [
          "symbolic-ref",
          "--short",
          "HEAD",
        ]),
      ).toBe("relay-data");
      expect(await fixture.git(fixture.options.cwd, ["symbolic-ref", "--short", "HEAD"])).toBe(
        "main",
      );
      expect(
        await fixture.git(fixture.remote, [
          "for-each-ref",
          "--format=%(objectname)",
          "refs/heads/relay-data",
        ]),
      ).toBe("");
      expect(
        await withSyncDatabase(fixture.location, (db) => db.getReplicationStatus().pending),
      ).toBe(pending);
    });
  }, 40_000);

  test.each(entrances)(
    "$name: status выбирает workspace-проект и не запускает созревший auto",
    async ({ wire }) => {
      await withGitSyncCli(async (fixture) => {
        await addProjectOrigin(fixture);
        const workspace = join(fixture.root, "workspace");
        const caller = join(fixture.root, "caller");
        mkdirSync(caller);
        initializeWorkspace({ ...fixture.options, cwd: workspace });
        registerProject({ ...fixture.options, cwd: workspace }, "commerce", fixture.options.cwd);
        makeProjectSyncDue(fixture.location);
        const before = await withSyncDatabase(fixture.location, (db) => ({
          pending: db.getReplicationStatus().pending,
          schedule: db.getSynchronizationSchedule(),
        }));
        const request = {
          version: 1,
          action: "status",
          options: {
            ...fixture.options,
            cwd: workspace,
            config: "relay.workspace.json",
            project: "commerce",
          },
          input: { refresh: false },
        };

        const response = wire
          ? await fixture.invoke(["--git-sync-request"], JSON.stringify(request), caller)
          : await fixture.invoke(
              [
                "git-sync",
                "status",
                "--config",
                join(workspace, "relay.workspace.json"),
                "--project",
                "commerce",
                "--format",
                "json",
              ],
              undefined,
              caller,
            );

        expect(response).toMatchObject({ exitCode: 0, stderr: "" });
        const envelope = objectValue(JSON.parse(response.stdout));
        expect(envelope.ok).toBe(true);
        const data = objectValue(envelope.data);
        const status = wire ? data : objectValue(objectValue(arrayValue(data.items)[0]).data);
        expect(status).toMatchObject({
          projectId: fixture.location.projectId,
          pending: { changesets: before.pending },
          connected: false,
        });
        if (wire) {
          expect(envelope.version).toBe(1);
        } else {
          expect(data).toMatchObject({ scope: "project", items: [{ name: "commerce", ok: true }] });
        }
        expect(gitCommands(fixture.tracePath)).toEqual([]);
        expect(existsSync(join(dirname(fixture.location.databasePath), "data"))).toBe(false);
        expect(
          await withSyncDatabase(fixture.location, (db) => ({
            pending: db.getReplicationStatus().pending,
            schedule: db.getSynchronizationSchedule(),
          })),
        ).toEqual(before);
      });
    },
    40_000,
  );

  test("now публикует очередь и возвращает requestId, чтение исхода не отправляет позднюю запись", async () => {
    await withGitSyncCli(async (fixture) => {
      await addProjectOrigin(fixture);
      const document = await withSyncDatabase(fixture.location, (db) =>
        new KnowledgeService(db).create(
          "document",
          { name: "Правила", body: "  Точный Markdown\n\n" },
          "author",
        ),
      );

      const response = await fixture.invoke(["git-sync", "now", "--format", "json"]);

      expect(response).toMatchObject({ exitCode: 0, stderr: "" });
      const envelope = objectValue(JSON.parse(response.stdout));
      expect(envelope.ok).toBe(true);
      const original = objectValue(envelope.data);
      const requestId = stringValue(original.requestId);
      expect(requestId).not.toBe("");
      expect(original).toMatchObject({ pending: { changesets: 0 } });
      const head = await fixture.git(fixture.remote, ["rev-parse", "refs/heads/relay-data"]);
      expect(
        await fixture.git(fixture.remote, ["rev-list", "--count", "refs/heads/relay-data"]),
      ).toBe("1");
      expect(
        await withSyncDatabase(
          fixture.location,
          (db) => new KnowledgeService(db).get("document", document.id).data.body,
        ),
      ).toBe("  Точный Markdown\n\n");

      const late = await withSyncDatabase(fixture.location, (db) =>
        new KnowledgeService(db).create(
          "document",
          { name: "Поздний", body: "Не публиковать при чтении outcome" },
          "author",
        ),
      );
      makeProjectSyncDue(fixture.location);
      // Новая запись и dirty worktree делают любой ошибочный повтор обмена наблюдаемым.
      const manifest = join(dirname(fixture.location.databasePath), "data", "manifest.json");
      writeFileSync(manifest, "не перезаписывать\n");
      rmSync(fixture.tracePath, { force: true });

      const query = await fixture.invoke([
        "git-sync",
        "request",
        "get",
        requestId,
        "--format",
        "json",
      ]);
      const waited = await fixture.invoke([
        "git-sync",
        "now",
        "--request-id",
        requestId,
        "--wait-ms",
        "1000",
        "--format",
        "json",
      ]);

      expect(query).toMatchObject({ exitCode: 0, stderr: "" });
      const { requestId: _requestId, ...summary } = original;
      expect(JSON.parse(query.stdout)).toMatchObject({
        ok: true,
        data: { requestId, state: "completed", action: "now", result: summary },
      });
      expect(waited).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(waited.stdout)).toEqual({ ok: true, data: original });
      expect(gitCommands(fixture.tracePath)).toEqual([]);
      expect(await fixture.git(fixture.remote, ["rev-parse", "refs/heads/relay-data"])).toBe(head);
      expect(readFileSync(manifest, "utf8")).toBe("не перезаписывать\n");
      expect(
        await withSyncDatabase(fixture.location, (db) => ({
          pending: db.getReplicationStatus().pending,
          document: new KnowledgeService(db).get("document", late.id),
        })),
      ).toMatchObject({
        pending: 1,
        document: { id: late.id, data: { body: "Не публиковать при чтении outcome" } },
      });
    });
  }, 40_000);

  test.each(entrances)(
    "$name: неизвестный requestId сохраняется в ошибке без нового submit",
    async ({ wire }) => {
      await withGitSyncCli(async (fixture) => {
        await addProjectOrigin(fixture);
        makeProjectSyncDue(fixture.location);
        const pending = await withSyncDatabase(
          fixture.location,
          (db) => db.getReplicationStatus().pending,
        );
        const requestId = "already-submitted-42";
        const request = {
          version: 1,
          action: "now",
          options: fixture.options,
          input: { requestId, waitMs: 1 },
        };

        const response = wire
          ? await fixture.invoke(["--git-sync-request"], JSON.stringify(request))
          : await fixture.invoke([
              "git-sync",
              "now",
              "--request-id",
              requestId,
              "--wait-ms",
              "1",
              "--format",
              "json",
            ]);

        expect(response.exitCode).toBe(4);
        expect(wire ? response.stderr : response.stdout).toBe("");
        const error = objectValue(JSON.parse(wire ? response.stdout : response.stderr));
        expect(error).toMatchObject({
          ok: false,
          error: {
            code: "GIT_SYNC_OUTCOME_UNKNOWN",
            details: { requestId, state: "unknown", instance: null },
          },
        });
        if (wire) {
          expect(error).toMatchObject({ version: 1, error: { exitCode: 4 } });
        }
        expect(gitCommands(fixture.tracePath)).toEqual([]);
        expect(
          await withSyncDatabase(fixture.location, (db) => db.getReplicationStatus().pending),
        ).toBe(pending);
        expect(
          await fixture.git(fixture.remote, [
            "for-each-ref",
            "--format=%(objectname)",
            "refs/heads/relay-data",
          ]),
        ).toBe("");
      });
    },
    40_000,
  );

  test("настоящий отказ Git сохраняет requestId и pending, а request get не повторяет сеть", async () => {
    await withGitSyncCli(async (fixture) => {
      await addProjectOrigin(fixture);
      renameSync(fixture.remote, `${fixture.remote}.offline`);
      const pending = await withSyncDatabase(
        fixture.location,
        (db) => db.getReplicationStatus().pending,
      );

      const response = await fixture.invoke(["git-sync", "now", "--format", "json"]);

      expect(response).toMatchObject({ exitCode: 1, stdout: "" });
      const envelope = objectValue(JSON.parse(response.stderr));
      expect(envelope).toMatchObject({
        ok: false,
        error: { code: "GIT_FAILED", details: { state: "failed" } },
      });
      const requestId = stringValue(objectValue(objectValue(envelope.error).details).requestId);
      expect(requestId).not.toBe("");
      expect(
        gitCommands(fixture.tracePath).filter(
          (argv) => argv.includes("ls-remote") || argv.includes("fetch"),
        ),
      ).toHaveLength(1);
      rmSync(fixture.tracePath, { force: true });

      const query = await fixture.invoke([
        "git-sync",
        "request",
        "get",
        requestId,
        "--format",
        "json",
      ]);

      expect(query).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(query.stdout)).toMatchObject({
        ok: true,
        data: { requestId, state: "failed", error: { code: "GIT_FAILED", exitCode: 1 } },
      });
      expect(gitCommands(fixture.tracePath)).toEqual([]);
      expect(
        await withSyncDatabase(fixture.location, (db) => db.getReplicationStatus().pending),
      ).toBe(pending);
    });
  }, 40_000);
});
