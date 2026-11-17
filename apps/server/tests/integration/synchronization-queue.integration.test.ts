import "reflect-metadata";
import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  initializeProject,
  initializeWorkspace,
  registerProject,
  type ProjectLocation,
} from "@relay/project-runtime";
import { ProjectDatabase } from "@relay/storage";
import { ProjectsService } from "../../src/modules/projects/projects.service";
import { prepareDueSynchronization } from "./synchronization-fixture";
import { deadline } from "../process/process-fixture";

/**
 * Занимает два слота обмена независимыми проектами, ставит третий в очередь и меняет его
 * состояние до освобождения слота. Четвёртый проект подтверждает обработку очереди без sleep:
 * close вызывается только после его старта, поэтому не может сам отбросить проверяемую работу.
 * Проверяет отсутствие RPC для третьего проекта и точные коды отдельной диагностики.
 * Владеет всеми SQLite, очередью и каталогом; change не должен оставлять открытых соединений.
 */
async function expectQueuedProjectSkipped(
  change: (queued: ProjectLocation, other: ProjectLocation) => void | Promise<void>,
  expectedWarnings: readonly string[] = [],
): Promise<void> {
  const parent = resolve(
    import.meta.dir,
    "../../../../.artifacts",
    new Date().toISOString().slice(0, 10),
    "background-sync-tests/queue",
  );
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "workspace-"));
  const runtime = { cwd: join(directory, "workspace"), home: join(directory, "home") };
  const release = Promise.withResolvers<void>();
  const occupied = Promise.withResolvers<void>();
  const reachedMarker = Promise.withResolvers<void>();
  const calls: string[] = [];
  const warnings: string[] = [];
  let service: ProjectsService | undefined;
  try {
    initializeWorkspace(runtime);
    /**
     * Создаёт только минимальную SQLite и регистрацию, не выполняя HTTP или Git.
     */
    function project(name: string): ProjectLocation {
      const cwd = join(directory, name);
      const location = initializeProject({ ...runtime, cwd, name });
      registerProject(runtime, name, cwd);
      prepareDueSynchronization(location);
      return location;
    }
    const first = project("first");
    const second = project("second");
    const queued = project("queued");
    const marker = project("marker");
    service = new ProjectsService({
      runtime,
      version: "test",
      actor: "Web",
      /**
       * Ошибка перепривязки не превращает уже успешное локальное чтение в отказ.
       */
      synchronizationWarning: (error): void => {
        warnings.push(error.code);
      },
      gitSync: {
        /**
         * Удерживает оба слота; маркер подтверждает FIFO-проход изменённого проекта.
         */
        request: async (request): Promise<null> => {
          expect(request.action).toBe("auto");
          const config = request.options.config;
          if (config === undefined) {
            throw new Error("Фоновый обмен потерял явный config проекта");
          }
          calls.push(config);
          if (calls.length === 2) {
            occupied.resolve();
          }
          if (config === marker.configPath) {
            reachedMarker.resolve();
          }
          await release.promise;
          return null;
        },
      },
    });
    await service.run(first.projectId, (db) => db.getGeneration());
    await service.run(second.projectId, (db) => db.getGeneration());
    await deadline(occupied.promise, 2000);
    await service.run(queued.projectId, (db) => db.getGeneration());
    await service.run(marker.projectId, (db) => db.getGeneration());
    expect(calls).toEqual([first.configPath, second.configPath]);

    await change(queued, first);
    release.resolve();
    await deadline(reachedMarker.promise, 2000);
    await service.close();

    expect(calls).toEqual([first.configPath, second.configPath, marker.configPath]);
    expect(warnings).toEqual([...expectedWarnings]);
  } finally {
    release.resolve();
    try {
      await service?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

describe("Повторная проверка queued-проекта перед фоновым Git", () => {
  test("переход в manual во время очереди отменяет RPC без диагностики", async () => {
    await expectQueuedProjectSkipped((queued) => {
      const db = ProjectDatabase.open(queued.databasePath);
      try {
        db.setSynchronizationMode("manual");
      } finally {
        db.close();
      }
    });
  });

  test("завершение обмена другим участником во время очереди отменяет ещё не созревший RPC", async () => {
    await expectQueuedProjectSkipped((queued) => {
      const db = ProjectDatabase.open(queued.databasePath);
      try {
        const at = Date.now();
        db.completeSynchronizationAttempt({ at, nextAttemptAt: at + 60_000, failed: false });
      } finally {
        db.close();
      }
    });
  });

  test("перепривязка queued-конфига к другому проекту даёт PROJECT_CHANGED без RPC", async () => {
    await expectQueuedProjectSkipped(
      async (queued, other) => {
        await writeFile(
          queued.configPath,
          JSON.stringify({
            version: 1,
            projectId: other.projectId,
            databasePath: other.databasePath,
          }),
        );
      },
      ["PROJECT_CHANGED"],
    );
  });

  test("другая физическая SQLite с прежним projectId даёт PROJECT_CHANGED без RPC", async () => {
    await expectQueuedProjectSkipped(
      async (queued) => {
        const replacement = join(dirname(queued.configPath), "replacement.sqlite");
        // Все соединения закрыты: копируется checkpointed SQLite с тем же постоянным ID.
        await copyFile(queued.databasePath, replacement);
        await writeFile(
          queued.configPath,
          JSON.stringify({
            version: 1,
            projectId: queued.projectId,
            databasePath: replacement,
          }),
        );
      },
      ["PROJECT_CHANGED"],
    );
  });
});
