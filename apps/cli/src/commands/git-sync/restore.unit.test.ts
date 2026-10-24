import { describe, expect, test } from "bun:test";
import { RelayError, type GitSyncRequest } from "@relay/contracts";
import type { GitSyncClient } from "@relay/project-runtime";
import { withCliFixture } from "../../../tests/integration/helpers/cli-fixture";
import { invokeIsolatedCli } from "../../../tests/helpers/help";

const group = "git-sync-implementation/cli-runtime/restore-resume";
const invocations = [
  {
    name: "resume с явным постоянным ID",
    args: ["--resume", "--project-id", "permanent-project"],
    input: { resume: true, projectId: "permanent-project" },
  },
  { name: "resume с выбором ID в Runtime", args: ["--resume"], input: { resume: true } },
  {
    name: "прежний explicit remote/branch",
    args: ["--remote", "../remote с пробелом", "--branch", "relay-data-v2"],
    input: { remote: "../remote с пробелом", branch: "relay-data-v2" },
  },
  {
    name: "явный resume=false сохраняет обычный restore",
    args: ["--resume=false", "--remote", "origin"],
    input: { remote: "origin" },
  },
] as const;
const invalidSources = [
  { name: "resume и remote", args: ["--resume", "--remote", "origin"] },
  { name: "resume и branch", args: ["--resume", "--branch", "other"] },
  { name: "ID без resume", args: ["--project-id", "project-id"] },
  { name: "ID при resume=false", args: ["--resume=false", "--project-id", "project-id"] },
  { name: "пустой ID", args: ["--resume", "--project-id", "  "] },
] as const;
const failures = [
  {
    name: "без config Runtime требует ID",
    code: "RESTORE_PROJECT_ID_REQUIRED",
    exitCode: 2,
    details: { cwd: "/unconfigured" },
  },
  {
    name: "неподтверждённое намерение сохраняет recovery details",
    code: "RESTORE_RECOVERY_REQUIRED",
    exitCode: 4,
    details: {
      reason: "pending-publication",
      location: {
        projectId: "project-id",
        databasePath: "/saved/project.sqlite",
        configPath: "/work/relay.config.json",
      },
      stagingPath: "/saved/staging",
      publicationPath: "/saved/intent.json",
      materializedInCurrentCall: false,
      sourceError: { code: "CONFIG_EXISTS", message: "Конфигурация занята" },
    },
  },
  {
    name: "завершённый resume сообщает отсутствие pending",
    code: "RESTORE_NOT_PENDING",
    exitCode: 3,
    details: { projectId: "project-id" },
  },
] as const;

/**
 * Подменяет только одноразовый process port; скрытый service/foreground fallback запрещён.
 */
function restorePort(request: GitSyncClient["request"]): GitSyncClient {
  return {
    request,
    /**
     * Restore не устанавливает пользовательскую службу.
     */
    service: async (): Promise<never> => {
      throw new Error("Restore не должен вызывать native service");
    },
    /**
     * Resume не запускает supervisor как замену завершению привязки.
     */
    supervise: async (): Promise<never> => {
      throw new Error("Restore не должен запускать supervisor");
    },
  };
}

describe("Явный restore resume CLI", () => {
  test.each(invocations)(
    "$name сохраняет точные options и source input",
    async ({ args, input }) => {
      await withCliFixture(async (fixture) => {
        const calls: GitSyncRequest[] = [];

        await fixture.success(
          ["git-sync", "restore", ...args, "--config", "registry.json", "--project", "commerce"],
          {
            gitSync: restorePort(async (request) => {
              calls.push(request);
              return { accepted: true };
            }),
          },
        );

        expect(calls).toEqual([
          {
            version: 1,
            action: "restore",
            options: {
              cwd: fixture.runtime.cwd,
              ...(fixture.runtime.env.RELAY_HOME === undefined
                ? {}
                : { home: fixture.runtime.env.RELAY_HOME }),
              config: "registry.json",
              project: "commerce",
            },
            input,
          },
        ]);
        expect(Object.hasOwn(calls[0]?.input ?? {}, "projectId")).toBe("projectId" in input);
      }, group);
    },
  );

  test.each(invalidSources)("$name отклоняется до process port", async ({ args }) => {
    await withCliFixture(async (fixture) => {
      let calls = 0;

      const failure = await fixture.error(["git-sync", "restore", ...args], 2, {
        gitSync: restorePort(async () => {
          calls++;
          return null;
        }),
      });

      expect(failure.code).toBe("INVALID_ARGUMENT");
      expect(calls).toBe(0);
    }, group);
  });

  test("успех resume сохраняет local result/cleanup metadata без заявления fetched HEAD", async () => {
    await withCliFixture(async (fixture) => {
      const location = {
        projectId: "project-id",
        databasePath: "/saved/project.sqlite",
        configPath: "/work/relay.config.json",
      };
      const resumed = {
        location,
        resumed: true,
        preservedExisting: true,
        sourceCheckpoint: null,
        recovery: {
          publicationPath: "/saved/intent.json",
          stagingPath: "/saved/staging",
          failure: { code: "RESTORE_CLEANUP_UNOWNED_FILES", message: "Сохранён companion" },
        },
        message: "Сохранённый локальный проект подключён",
        ...location,
      };

      const response = await fixture.success(
        ["git-sync", "restore", "--resume", "--project-id", location.projectId],
        { gitSync: restorePort(async () => resumed) },
      );

      expect(response.data).toEqual(resumed);
      expect(response.data).not.toHaveProperty("commit");
      expect(response.data).not.toHaveProperty("restored");
    }, group);
  });

  test.each(failures)(
    "$name: исходный code/exit/details проходят без adoption и retry",
    async ({ code, exitCode, details }) => {
      await withCliFixture(async (fixture) => {
        let calls = 0;
        const failure = await fixture.error(["git-sync", "restore", "--resume"], exitCode, {
          gitSync: restorePort(async (request) => {
            expect(request.input).toEqual({ resume: true });
            calls++;
            throw new RelayError(code, "Сохранённый recovery-исход", exitCode, details);
          }),
        });

        expect(failure).toEqual({ code, message: "Сохранённый recovery-исход", details });
        expect(calls).toBe(1);
      }, group);
    },
  );

  test.each(["--help", "--version"])(
    "%s не выбирает ID/config и не исполняет конфликтующие sources",
    async (flag) => {
      const response = await invokeIsolatedCli([
        "git-sync",
        "restore",
        "--resume",
        "--remote",
        "origin",
        "--project-id",
        "project-id",
        flag,
      ]);

      expect(response.exitCode).toBe(0);
      expect(response.stderr).toBe("");
      if (flag === "--help") {
        expect(response.stdout).toContain("--project-id");
        expect(response.stdout).toContain("sourceCheckpoint:null");
        expect(response.stdout).toContain("RESTORE_NOT_PENDING");
        expect(response.stdout).toContain("не выполняет fetch/материализацию");
      }
    },
  );
});
