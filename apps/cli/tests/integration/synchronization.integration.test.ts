import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { RelayError, type GitSyncRequest } from "@relay/contracts";
import { BatchService, KnowledgeService } from "@relay/core";
import type { ProjectLocation } from "@relay/project-runtime";
import { ProjectDatabase } from "@relay/storage";
import { requestClient } from "../helpers/git-sync-client";
import { withCliFixture } from "./helpers/cli-fixture";
import { entityValue, readEntitiesValue, stringValue, successValue } from "./helpers/responses";

const group = "project-local-sync/cli-server-review/fixtures";
const reads = [
  { name: "предметный snapshot", argv: ["document", "get", "DOC-1"], grouped: false },
  { name: "versioned get", argv: ["get", "DOC-1", "--with-versions"], grouped: true },
] as const;
const mutations = [
  { name: "document update", batch: false },
  { name: "batch без --check", batch: true },
] as const;
const diagnostics = [
  { name: "storage status", argv: ["storage", "status"], expected: { records: 3 } },
  {
    name: "doctor check",
    argv: ["doctor", "check"],
    expected: { valid: true, records: 3, issues: [] },
  },
] as const;
const invalidReads = [
  { name: "отсутствие адресов", refs: [] },
  { name: "201 адрес с учётом --", refs: [...Array<string>(200).fill("PROJECT"), "--", "PROJECT"] },
] as const;

/**
 * Делает только техническое расписание созревшим, без ожиданий и изменения предметных данных.
 * Соединение принадлежит helper и закрывается до проверяемой CLI-команды.
 */
function makeSynchronizationDue(project: ProjectLocation): void {
  const database = new Database(project.databasePath);
  try {
    database.exec(
      "UPDATE synchronization_schedule SET dirty_since=0,last_mutation_at=0,next_attempt_at=0",
    );
  } finally {
    database.close();
  }
}

describe("Ленивый обмен перед предметной командой CLI", () => {
  test("отмена вызывающего во время auto не запускает последующую мутацию", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      mkdirSync(join(cli.runtime.cwd, ".git"));
      makeSynchronizationDue(project);
      const cancellation = new AbortController();
      const before = cli.withDatabase(project, (db) => db.getReplicationStatus());
      const gitSync = requestClient(async () => {
        cancellation.abort("SIGINT");
        throw new RelayError("GIT_SYNC_CANCELLED", "Отменено вызывающим", 130);
      });

      const failure = await cli.error(
        ["document", "create", "--name", "Не создавать", "--body", "Отмена до записи"],
        130,
        { gitSync, signal: cancellation.signal },
      );

      expect(failure.code).toBe("GIT_SYNC_CANCELLED");
      expect(cli.withDatabase(project, (db) => db.count("document"))).toBe(0);
      expect(cli.withDatabase(project, (db) => db.getReplicationStatus())).toEqual(before);
    }, group);
  });

  test.each(reads)(
    "$name через --config видит запись обмена до начала чтения",
    async ({ argv, grouped }) => {
      await withCliFixture(async (cli) => {
        const project = cli.createProject();
        mkdirSync(join(cli.runtime.cwd, ".git"));
        const cwd = join(cli.root, "caller-without-git");
        mkdirSync(cwd);
        const initial = await cli.withDatabase(project, (db) =>
          new KnowledgeService(db).create(
            "document",
            { name: "Правила", body: "До обмена" },
            "author",
          ),
        );
        makeSynchronizationDue(project);
        const calls: GitSyncRequest[] = [];
        const gitSync = requestClient(async (request) => {
          calls.push(request);
          // Второе соединение фиксирует пришедшее содержание только после async-границы порта.
          await Promise.resolve();
          return cli.withDatabase(project, (db) =>
            new KnowledgeService(db).update(
              "document",
              initial.id,
              { body: "Получено при обмене" },
              {
                actor: "remote",
                ifRevision: initial.revision,
              },
            ),
          );
        });

        const response = await cli.success([...argv, "--config", project.configPath], {
          cwd,
          gitSync,
        });

        const document = grouped ? readEntitiesValue(response.data)[0] : entityValue(response.data);
        expect(document).toMatchObject({
          id: initial.id,
          revision: initial.revision + 1,
          data: { body: "Получено при обмене" },
          updatedBy: "remote",
        });
        expect(calls).toEqual([
          {
            version: 1,
            action: "auto",
            options: {
              cwd,
              config: project.configPath,
              home: stringValue(cli.runtime.env.RELAY_HOME),
            },
          },
        ]);
      }, group);
    },
  );

  test.each(mutations)(
    "$name: исходный CAS после обмена отклоняется без потери пришедшего текста",
    async ({ batch }) => {
      await withCliFixture(async (cli) => {
        const project = cli.createProject();
        mkdirSync(join(cli.runtime.cwd, ".git"));
        const initial = await cli.withDatabase(project, (db) =>
          new KnowledgeService(db).create(
            "document",
            { name: "Правила", body: "До обмена" },
            "author",
          ),
        );
        makeSynchronizationDue(project);
        const calls: GitSyncRequest[] = [];
        const gitSync = requestClient(async (request) => {
          calls.push(request);
          return cli.withDatabase(project, (db) =>
            new KnowledgeService(db).update(
              "document",
              initial.id,
              { body: "Пришедшая правка" },
              {
                actor: "remote",
                ifRevision: initial.revision,
              },
            ),
          );
        });
        const argv = batch
          ? [
              "batch",
              "--operation-key",
              "stale-after-auto",
              "--input",
              JSON.stringify({
                version: 1,
                operations: [
                  {
                    op: "document.update",
                    ref: initial.key,
                    ifRevision: initial.revision,
                    input: { body: "Устаревший текст" },
                  },
                ],
              }),
            ]
          : [
              "document",
              "update",
              initial.key,
              "--body",
              "Устаревший текст",
              "--if-revision",
              String(initial.revision),
            ];

        const error = await cli.error(argv, 4, { gitSync });

        expect(error.code).toBe("REVISION_CONFLICT");
        expect(calls.map((request) => request.action)).toEqual(["auto"]);
        expect(
          cli.withDatabase(project, (db) => new KnowledgeService(db).get("document", initial.id)),
        ).toMatchObject({
          revision: initial.revision + 1,
          data: { body: "Пришедшая правка" },
          updatedBy: "remote",
        });
      }, group);
    },
  );

  test("отказ доставки пишет отдельную warning, но возвращает и сохраняет локальную мутацию", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      mkdirSync(join(cli.runtime.cwd, ".git"));
      makeSynchronizationDue(project);
      const calls: GitSyncRequest[] = [];
      const gitSync = requestClient(async (request) => {
        calls.push(request);
        throw new RelayError("REMOTE_OFFLINE", "Нет сети", 7);
      });

      const response = await cli.invoke(
        ["document", "create", "--name", "Локальный", "--body", "Не терять", "--format", "json"],
        { gitSync },
      );

      expect(response.code).toBe(0);
      expect(JSON.parse(response.stderr)).toEqual({
        type: "git-sync",
        level: "warning",
        error: { code: "REMOTE_OFFLINE", message: "Нет сети" },
      });
      const document = entityValue(successValue(JSON.parse(response.stdout)).data);
      expect(document).toMatchObject({
        kind: "document",
        data: { name: "Локальный", body: "Не терять" },
      });
      const stored = cli.withDatabase(project, (db) =>
        new KnowledgeService(db).get("document", document.id),
      );
      expect(document).toEqual(stored);
      expect(calls.map((request) => request.action)).toEqual(["auto"]);
    }, group);
  });

  test("свежий debounce не вызывает порт и чтение не продлевает расписание", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      mkdirSync(join(cli.runtime.cwd, ".git"));
      const schedule = cli.withDatabase(project, (db) => db.getSynchronizationSchedule());
      if (schedule.lastMutationAt === null) {
        throw new Error("Init должен оставить начальную публикацию в очереди");
      }
      const calls: GitSyncRequest[] = [];
      const clock = spyOn(Date, "now").mockReturnValue(schedule.lastMutationAt);
      try {
        const document = await cli.entity(["project", "get"], {
          gitSync: requestClient(async (request) => {
            calls.push(request);
            return null;
          }),
        });

        expect(document.id).toBe(project.projectId);
        expect(calls).toEqual([]);
        expect(cli.withDatabase(project, (db) => db.getSynchronizationSchedule())).toEqual(
          schedule,
        );
      } finally {
        clock.mockRestore();
      }
    }, group);
  });

  test(".git родителя не включает обмен вложенного проекта без собственного .git", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      mkdirSync(join(cli.root, ".git"));
      makeSynchronizationDue(project);
      const calls: GitSyncRequest[] = [];

      const document = await cli.entity(["project", "get"], {
        gitSync: requestClient(async (request) => {
          calls.push(request);
          return null;
        }),
      });

      expect(document.id).toBe(project.projectId);
      expect(calls).toEqual([]);
    }, group);
  });
});

describe("Локальные исключения из автоматического обмена CLI", () => {
  test.each(diagnostics)(
    "$name не вызывает порт при созревшем обмене",
    async ({ argv, expected }) => {
      await withCliFixture(async (cli) => {
        const project = cli.createProject();
        mkdirSync(join(cli.runtime.cwd, ".git"));
        makeSynchronizationDue(project);
        const calls: GitSyncRequest[] = [];

        const response = await cli.success(argv, {
          gitSync: requestClient(async (request) => {
            calls.push(request);
            return null;
          }),
        });

        expect(response.data).toMatchObject(expected);
        expect(calls).toEqual([]);
      }, group);
    },
  );

  test("batch result читает первоначальную receipt без запуска auto", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      mkdirSync(join(cli.runtime.cwd, ".git"));
      const original = await cli.withDatabase(project, (db) =>
        new BatchService(db).execute(
          {
            version: 1,
            operations: [
              { op: "document.create", input: { name: "Квитанция", body: "Исходный текст" } },
            ],
          },
          { actor: "author", operationKey: "saved" },
        ),
      );
      makeSynchronizationDue(project);
      const calls: GitSyncRequest[] = [];

      const response = await cli.success(["batch", "result", "saved", "--return", "full"], {
        gitSync: requestClient(async (request) => {
          calls.push(request);
          return null;
        }),
      });

      expect(response.data).toEqual({ ...original, replayed: true });
      expect(calls).toEqual([]);
    }, group);
  });

  test("batch --check не вызывает auto и оставляет данные и расписание неизменными", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      mkdirSync(join(cli.runtime.cwd, ".git"));
      makeSynchronizationDue(project);
      const schedule = cli.withDatabase(project, (db) => db.getSynchronizationSchedule());
      const calls: GitSyncRequest[] = [];
      const input = {
        version: 1,
        operations: [{ op: "document.create", input: { name: "Проба", body: "Без записи" } }],
      };

      const response = await cli.success(["batch", "--check", "--input", JSON.stringify(input)], {
        gitSync: requestClient(async (request) => {
          calls.push(request);
          return null;
        }),
      });

      expect(response.data).toMatchObject({ status: "checked" });
      expect(cli.withDatabase(project, (db) => db.list("document"))).toEqual([]);
      expect(cli.withDatabase(project, (db) => db.getSynchronizationSchedule())).toEqual(schedule);
      expect(calls).toEqual([]);
    }, group);
  });

  test.each(invalidReads)("get: $name отклоняется до открытия БД и порта", async ({ refs }) => {
    await withCliFixture(async (cli) => {
      cli.createProject();
      mkdirSync(join(cli.runtime.cwd, ".git"));
      const calls: GitSyncRequest[] = [];
      const open = spyOn(ProjectDatabase, "open");
      try {
        const response = await cli.invoke(["get", "--format=json", ...refs], {
          gitSync: requestClient(async (request) => {
            calls.push(request);
            return null;
          }),
        });

        expect(response).toMatchObject({ code: 2, stdout: "" });
        expect(JSON.parse(response.stderr)).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
        expect(open).not.toHaveBeenCalled();
        expect(calls).toEqual([]);
      } finally {
        open.mockRestore();
      }
    }, group);
  });

  test("help в созревшем Git-проекте не читает stdin, БД и процессный порт", async () => {
    await withCliFixture(async (cli) => {
      const project = cli.createProject();
      mkdirSync(join(cli.runtime.cwd, ".git"));
      makeSynchronizationDue(project);
      const calls: GitSyncRequest[] = [];
      const open = spyOn(ProjectDatabase, "open");
      let inputReads = 0;
      try {
        const response = await cli.invoke(["batch", "--input", "-", "--help"], {
          gitSync: requestClient(async (request) => {
            calls.push(request);
            return null;
          }),
          /**
           * Счётчик отличает автономную справку от проглоченного отказа чтения stdin.
           */
          stdin: (): string => {
            inputReads++;
            return "";
          },
        });

        expect(response).toMatchObject({ code: 0, stderr: "" });
        expect(response.stdout).toContain("--check");
        expect(inputReads).toBe(0);
        expect(open).not.toHaveBeenCalled();
        expect(calls).toEqual([]);
      } finally {
        open.mockRestore();
      }
    }, group);
  });
});
