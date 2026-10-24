import { describe, expect, test } from "bun:test";
import {
  RelayError,
  type GitSyncBlockedChangeset,
  type GitSyncConflictList,
  type GitSyncConflictResolutionResult,
  type GitSyncRequest,
} from "@relay/contracts";
import type { GitSyncClient } from "@relay/project-runtime";
import { withCliFixture } from "../../../tests/integration/helpers/cli-fixture";
import { invokeIsolatedCli } from "../../../tests/helpers/help";

const group = "git-sync-implementation/finalization/bounded-app/cli-fixtures";
const blocked: GitSyncBlockedChangeset = {
  id: "dependent-source",
  state: "pending",
  code: "REPLICATION_DEPENDENCY",
  message: "Изменение ожидает принятия причинной зависимости",
  dependencies: ["parent-source"],
};
const diagnostics: GitSyncConflictList = {
  conflicts: [
    {
      id: "parent-source",
      fingerprint: "actual-fingerprint",
      code: "TEXT_CONFLICT",
      message: "Стороны расходятся",
    },
  ],
  blocked: [blocked],
};

/**
 * Подменяет только процессный порт: диагностика не вызывает lifecycle службы или foreground.
 */
function diagnosticPort(request: GitSyncClient["request"]): GitSyncClient {
  return {
    request,
    /**
     * Обнаруживает неожиданный native service вызов.
     */
    service: async (): Promise<never> => {
      throw new Error("Диагностика не устанавливает службу");
    },
    /**
     * Обнаруживает неожиданный запуск supervisor.
     */
    supervise: async (): Promise<never> => {
      throw new Error("Диагностика не запускает foreground");
    },
  };
}

describe("CLI: отдельная диагностика blocked", () => {
  test("list сохраняет оба явных массива в JSON и отдельные подписи в тексте", async () => {
    await withCliFixture(async (cli) => {
      const requests: GitSyncRequest[] = [];
      const gitSync = diagnosticPort(async (request) => {
        requests.push(request);
        return diagnostics;
      });

      const json = await cli.success(["git-sync", "conflicts", "list"], { gitSync });
      const text = await cli.invoke(["git-sync", "conflicts", "list"], { gitSync });

      expect(json.data).toEqual(diagnostics);
      expect(text).toMatchObject({ code: 0, stderr: "" });
      expect(text.stdout).toContain("Конфликты: ID: parent-source");
      expect(text.stdout).toContain("Fingerprint сторон для resolve: actual-fingerprint");
      expect(text.stdout).toContain("Ожидают зависимостей: ID: dependent-source");
      expect(text.stdout).toContain("Состояние: pending");
      expect(text.stdout).toContain("Непринятые предшественники: parent-source");
      expect(requests.map((request) => ({ action: request.action, input: request.input }))).toEqual(
        [
          { action: "conflicts.list", input: undefined },
          { action: "conflicts.list", input: undefined },
        ],
      );
    }, group);
  });

  test("get blocked показывает точные dependencies без fingerprint и предложения resolve", async () => {
    await withCliFixture(async (cli) => {
      const gitSync = diagnosticPort(async (request) => {
        expect(request).toMatchObject({ action: "conflicts.get", input: { id: blocked.id } });
        return blocked;
      });
      const json = await cli.success(["git-sync", "conflicts", "get", blocked.id], { gitSync });
      const text = await cli.invoke(["git-sync", "conflicts", "get", blocked.id], { gitSync });

      expect(json.data).toEqual(blocked);
      expect(text).toEqual({
        code: 0,
        stderr: "",
        stdout:
          "ID: dependent-source\nСостояние: pending\nКод: REPLICATION_DEPENDENCY\nПричина: Изменение ожидает принятия причинной зависимости\nНепринятые предшественники: parent-source\n",
      });
      expect(text.stdout).not.toContain("fingerprint");
      expect(text.stdout).not.toContain("resolve");
    }, group);
  });

  test("resolve сохраняет полные remaining списки и pending рядом с bounded preview", async () => {
    await withCliFixture(async (cli) => {
      const response: GitSyncConflictResolutionResult = {
        id: "resolved-source",
        generation: 12,
        included: ["resolved-source"],
        conflicts: diagnostics.conflicts,
        blocked: [blocked],
        pending: 9,
        deferred: [blocked.id],
        hasMore: true,
      };
      const result = await cli.success(
        [
          "git-sync",
          "conflicts",
          "resolve",
          response.id,
          "--input",
          '{"choice":"local","fingerprint":"read"}',
          "--actor",
          "human",
        ],
        {
          gitSync: diagnosticPort(async (request) => {
            expect(request.input).toEqual({
              id: response.id,
              decision: { choice: "local", fingerprint: "read" },
              actor: "human",
            });
            return response;
          }),
        },
      );
      expect(result.data).toEqual(response);
    }, group);
  });

  test("отказ resolve blocked сохраняет exit 4 и объяснение без повторного запроса", async () => {
    await withCliFixture(async (cli) => {
      let calls = 0;
      const failure = await cli.error(
        [
          "git-sync",
          "conflicts",
          "resolve",
          blocked.id,
          "--input",
          '{"choice":"local","fingerprint":"invented"}',
          "--actor",
          "human",
        ],
        4,
        {
          gitSync: diagnosticPort(async () => {
            calls++;
            throw new RelayError("REPLICATION_DEPENDENCY", "Пакет ожидает dependencies", 4, {
              blocked,
            });
          }),
        },
      );
      expect(failure).toEqual({
        code: "REPLICATION_DEPENDENCY",
        message: "Пакет ожидает dependencies",
        details: { blocked },
      });
      expect(calls).toBe(1);
    }, group);
  });

  test("help объясняет pending и сохраняет guards настоящего resolve", async () => {
    const list = await invokeIsolatedCli(["git-sync", "conflicts", "list", "--help"]);
    const get = await invokeIsolatedCli(["git-sync", "conflicts", "get", "--help"]);
    const resolve = await invokeIsolatedCli(["git-sync", "conflicts", "resolve", "--help"]);
    for (const response of [list, get, resolve]) {
      expect(response).toMatchObject({ exitCode: 0, stderr: "" });
      expect(response.stdout).toContain("blocked");
    }
    expect(list.stdout).toContain("{conflicts: [...], blocked: [...]}");
    expect(get.stdout).toContain("Такой пакет не требует resolve");
    expect(resolve.stdout).toContain("Устаревший fingerprint отклоняется");
    expect(resolve.stdout).toContain('choice: "local" либо "remote"');
    expect(resolve.stdout).toContain("не подтверждает доставку");
    expect(resolve.stdout).toContain("без сохранения решения");
  });
});
