import { describe, expect, spyOn, test } from "bun:test";
import * as files from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { RelayError } from "@relay/contracts";
import { initializeProject } from "@relay/project-runtime";
import { ProjectDatabase } from "@relay/storage";
import { executeGitSyncRequest } from "../../src/index";
import * as projectConnection from "../../src/app/project-connection";
import * as preparation from "../../src/app/restore-preparation";
import * as git from "../../src/transport/git";
import { DataRepository } from "../../src/transport/repository";
import { readEndpoint, responsive, acquireControlLock } from "../../src/local/control";
import { withExchangeDirectory } from "./helpers/exchange-fixture";
import { containsFailure } from "./helpers/source-runtime-fixture";

describe("Cleanup отменённого библиотечного обращения", () => {
  test("raw отказ удаления restore staging сохраняется вместе с отменой, а owner освобождается", async () => {
    await withExchangeDirectory(async (root) => {
      const home = join(root, "home");
      mkdirSync(home);
      const options = { cwd: root, home: join(root, "runtime-home") };
      const controller = new AbortController();
      const primary = new RelayError("GIT_CANCELLED", "Подготовка прервана", 1);
      const cleanup = Object.assign(new Error("Staging не удалён"), { code: "EACCES" });
      const preparationDirectory = join(
        options.home,
        ".restore",
        createHash("sha256").update(join(root, "relay.config.json")).digest("hex"),
      );
      const endpointPath = join(preparationDirectory, "worker.json");
      let temporary: string | undefined;
      const actualRemove = files.rmSync;
      const remove = spyOn(files, "rmSync").mockImplementation((path, options) => {
        if (typeof path === "string" && path.startsWith(join(preparationDirectory, "restore-"))) {
          temporary = path;
          throw cleanup;
        }
        actualRemove(path, options);
      });
      const validate = spyOn(git, "validateBranch").mockResolvedValue(undefined);
      const prepare = spyOn(preparation, "prepareRestoration").mockImplementation(async () => {
        controller.abort("SIGTERM");
        throw primary;
      });
      try {
        const failure: unknown = await executeGitSyncRequest(
          { version: 1, action: "restore", options, input: { remote: join(root, "remote.git") } },
          {
            env: { ...process.env, HOME: home, USERPROFILE: home, RELAY_HOME: options.home },
            signal: controller.signal,
          },
        ).catch((error: unknown) => error);

        expect(controller.signal.aborted).toBe(true);
        expect(failure).not.toMatchObject({ code: "GIT_SYNC_CANCELLED" });
        expect(containsFailure(failure, primary)).toBe(true);
        expect(containsFailure(failure, cleanup)).toBe(true);
        expect(failure).toMatchObject({
          cause: {
            errors: [
              primary,
              { code: "GIT_CLEANUP_FAILED", details: { operation: "restore-staging-cleanup" } },
            ],
          },
        });
        expect(typeof temporary).toBe("string");
        expect(temporary !== undefined && existsSync(temporary)).toBe(true);
        expect(existsSync(join(options.home, "projects"))).toBe(false);
        expect(existsSync(join(root, "relay.config.json"))).toBe(false);
        expect(existsSync(endpointPath)).toBe(false);
        const lock = acquireControlLock(endpointPath);
        lock.release();
      } finally {
        controller.abort();
        prepare.mockRestore();
        validate.mockRestore();
        remove.mockRestore();
      }
    });
  });

  test("raw отказ unlink endpoint сохраняется после отмены connect, listener закрыт и outbox цел", async () => {
    await withExchangeDirectory(async (root) => {
      const home = join(root, "home");
      mkdirSync(home);
      // Git-вызовы ниже подменены, но fingerprint common-dir проверяет настоящий каталог.
      mkdirSync(join(root, ".git"));
      const options = { cwd: root, home: join(root, "runtime-home") };
      const location = initializeProject({ ...options, name: "Endpoint cleanup" });
      const initial = ProjectDatabase.open(location.databasePath);
      let outbox: ReturnType<ProjectDatabase["getReplicationOutbox"]>;
      try {
        outbox = initial.getReplicationOutbox();
      } finally {
        initial.close();
      }
      const controller = new AbortController();
      const primary = new RelayError("GIT_CANCELLED", "Worktree подготовка прервана", 1);
      const cleanup = Object.assign(new Error("Endpoint не удалён"), { code: "EACCES" });
      const endpointPath = join(
        options.home,
        "projects",
        location.projectId,
        "state",
        "worker.json",
      );
      const actualUnlink = files.unlinkSync;
      const unlink = spyOn(files, "unlinkSync").mockImplementation((path) => {
        if (path === endpointPath) {
          throw cleanup;
        }
        actualUnlink(path);
      });
      const validate = spyOn(git, "validateBranch").mockResolvedValue(undefined);
      const initializeProjectRepository = spyOn(
        projectConnection,
        "initializeProjectRepository",
      ).mockResolvedValue(false);
      const commonDirectory = spyOn(
        projectConnection,
        "projectGitCommonDirectory",
      ).mockResolvedValue(join(root, ".git"));
      const initialize = spyOn(DataRepository.prototype, "initialize").mockImplementation(
        async () => {
          controller.abort("SIGTERM");
          throw primary;
        },
      );
      try {
        const failure: unknown = await executeGitSyncRequest(
          { version: 1, action: "connect", options, input: { remote: join(root, "remote.git") } },
          {
            env: { ...process.env, HOME: home, USERPROFILE: home, RELAY_HOME: options.home },
            signal: controller.signal,
          },
        ).catch((error: unknown) => error);

        expect(controller.signal.aborted).toBe(true);
        expect(failure).not.toMatchObject({ code: "GIT_SYNC_CANCELLED" });
        expect(containsFailure(failure, primary)).toBe(true);
        expect(containsFailure(failure, cleanup)).toBe(true);
        expect(failure).toMatchObject({
          cause: {
            errors: [
              primary,
              { code: "GIT_CLEANUP_FAILED", details: { operation: "control-owner-cleanup" } },
            ],
          },
        });
        const endpoint = readEndpoint(endpointPath);
        if (endpoint === null) {
          throw new Error("Инъекция unlink должна сохранить endpoint файл");
        }
        expect(await responsive(endpoint)).toBe(false);
        const lock = acquireControlLock(endpointPath);
        lock.release();
        const reopened = ProjectDatabase.open(location.databasePath);
        try {
          expect(reopened.getReplicationOutbox()).toEqual(outbox);
        } finally {
          reopened.close();
        }
      } finally {
        controller.abort();
        initialize.mockRestore();
        initializeProjectRepository.mockRestore();
        commonDirectory.mockRestore();
        validate.mockRestore();
        unlink.mockRestore();
      }
    });
  });
});
