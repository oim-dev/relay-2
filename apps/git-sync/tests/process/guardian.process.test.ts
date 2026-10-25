import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GuardedCommandError, runGuardedCommand } from "@relay/project-runtime";
import { encodeFrame, createRequest } from "./guardian-helpers/wire";
import {
  observe,
  ready,
  running,
  startOwner,
  withGuardianFixture,
} from "./guardian-helpers/fixture";
import type { TreeReady } from "./guardian-helpers/fixture.types";
import { withOwnerObservation } from "./guardian-helpers/owner-observation";

const brokenEntry = fileURLToPath(new URL("./guardian-helpers/broken-entry.ts", import.meta.url));
const sourceEntry = fileURLToPath(new URL("./guardian-helpers/entry.ts", import.meta.url));
const linuxProcfsEntry = fileURLToPath(
  new URL("./guardian-helpers/linux-procfs-entry.ts", import.meta.url),
);

/**
 * Подтверждает остановку всех известных PID до выхода теста и до аварийного finally fixture.
 */
async function expectTreeStopped(tree: TreeReady): Promise<void> {
  await observe(() => Object.values(tree).every((pid) => !running(pid)));
  for (const pid of Object.values(tree)) {
    expect(running(pid)).toBe(false);
  }
}

describe("Владение деревом защищённой команды", () => {
  test.skipIf(process.platform === "win32")(
    "чистая POSIX-группа очищает вложенных helpers после exit команды без помощи Linux subreaper",
    async () => {
      await withGuardianFixture(async ({ options, actor, root }) => {
        // Роль anchor не включает subreaper: проверяем именно примитив, используемый на macOS.
        const anchor = spawn(process.execPath, [sourceEntry, "--guarded-command"], {
          stdio: ["pipe", "pipe", "pipe", "ipc"],
          detached: true,
          serialization: "json",
        });
        anchor.stdout?.resume();
        anchor.stderr?.resume();
        const exited = new Promise<void>((resolve) => anchor.once("close", () => resolve()));
        const outcome = new Promise<unknown>((resolve, reject) => {
          anchor.once("message", resolve);
          anchor.once("error", reject);
        });
        let stopped = false;
        try {
          if (!anchor.pid || !anchor.stdin) {
            throw new Error("Не запущен собственный POSIX-якорь fixture");
          }
          anchor.stdin.write(
            encodeFrame({
              ...createRequest({ ...options, argv: [...actor, "tree", root] }),
              role: "anchor",
            }),
          );
          const tree = await ready(root);
          writeFileSync(join(root, "release"), "exit");
          expect(await outcome).toEqual({ version: 1, kind: "result", code: 0 });
          expect([tree.anchor, tree.branch, tree.leaf].every(running)).toBe(true);

          anchor.stdin.end();
          stopped = true;
          await exited;

          await expectTreeStopped(tree);
        } finally {
          if (!stopped && anchor.pid) {
            process.kill(-anchor.pid, "SIGKILL");
          }
          anchor.stdin?.destroy();
          await exited;
        }
      });
    },
  );

  test("исходный component [bun, entry.ts] запускает тот же приватный протокол и отдельный якорь", async () => {
    await withGuardianFixture(async ({ options }) => {
      const result = await runGuardedCommand({
        ...options,
        component: [process.execPath, sourceEntry],
        input: "source-entry\0",
      });

      expect(result.code).toBe(0);
      expect(Buffer.from(result.stdout)).toEqual(Buffer.from("source-entry\0"));
    });
  });

  test("оба output читаются конкурентно при заполненных pipe и большом бинарном stdin", async () => {
    await withGuardianFixture(async ({ options, actor }) => {
      const input = Buffer.from(Array.from({ length: 128 * 1024 }, (_, index) => index % 256));

      const result = await runGuardedCommand({ ...options, argv: [...actor, "duplex"], input });

      expect(result.code).toBe(0);
      expect(Buffer.from(result.stdout)).toEqual(input);
      expect(result.stderr).toBe("A".repeat(256 * 1024));
    });
  });

  test("stdin закрывается после ввода, бинарный stdout сохраняется и ненулевой exit не становится отказом guardian", async () => {
    await withGuardianFixture(async ({ options, actor }) => {
      const input = Buffer.from([0, 1, 255, 254, 195, 0, 128, 10, 65]);

      const result = await runGuardedCommand({ ...options, argv: [...actor, "echo", "23"], input });

      expect(result.code).toBe(23);
      expect(Buffer.from(result.stdout)).toEqual(input);
      expect(result.stderr).toBe("диагностика команды\n");
    });
  });

  test("обычный exit команды очищает ещё живых вложенных потомков с закрытыми stdio", async () => {
    await withGuardianFixture(async ({ options, actor, root }) => {
      const completion = runGuardedCommand({ ...options, argv: [...actor, "tree", root] });
      const tree = await ready(root);
      expect(Object.values(tree).every(running)).toBe(true);

      writeFileSync(join(root, "release"), "exit");
      const result = await completion;

      expect(result.code).toBe(0);
      expect(Buffer.from(result.stdout).toString()).toBe("command-completed");
      await expectTreeStopped(tree);
    });
  });

  test("deadline guardian завершает настоящее вложенное дерево, игнорирующее SIGTERM", async () => {
    await withGuardianFixture(async ({ options, actor, root }) => {
      const completion = runGuardedCommand({
        ...options,
        argv: [...actor, "tree", root],
        timeoutMs: 2000,
      });
      const failure = completion.catch((error: unknown) => error);
      const tree = await ready(root);

      const error = await failure;

      expect(error).toBeInstanceOf(GuardedCommandError);
      expect(error).toMatchObject({ reason: "timeout" });
      await expectTreeStopped(tree);
    });
  }, 10_000);

  test("общий output budget ограничивает память и завершает всех потомков", async () => {
    await withGuardianFixture(async ({ options, actor, root }) => {
      const completion = runGuardedCommand({
        ...options,
        argv: [...actor, "tree", root],
        maxOutputBytes: 128,
      });
      const failure = completion.catch((error: unknown) => error);
      const tree = await ready(root);

      writeFileSync(join(root, "release"), "budget");
      const error = await failure;

      expect(error).toBeInstanceOf(GuardedCommandError);
      if (!(error instanceof GuardedCommandError)) {
        throw error;
      }
      expect(error.reason).toBe("output-limit");
      expect(error.stdout.length + Buffer.byteLength(error.stderr)).toBeLessThanOrEqual(128);
      await expectTreeStopped(tree);
    });
  });

  test("AbortSignal закрывает lease и не оставляет живой nested helper", async () => {
    await withGuardianFixture(async ({ options, actor, root }) => {
      const cancellation = new AbortController();
      const completion = runGuardedCommand({
        ...options,
        argv: [...actor, "tree", root],
        signal: cancellation.signal,
      });
      const failure = completion.catch((error: unknown) => error);
      const tree = await ready(root);

      cancellation.abort();
      const error = await failure;

      expect(error).toBeInstanceOf(GuardedCommandError);
      expect(error).toMatchObject({ reason: "cancelled" });
      await expectTreeStopped(tree);
    });
  });

  test.each(["SIGTERM", "SIGKILL"] as const)(
    "смерть владельца через %s очищает дерево, пока тестовый runner продолжает работу",
    async (signal) => {
      await withGuardianFixture(async ({ options, actor, root }) => {
        const owner = startOwner(root, { ...options, argv: [...actor, "tree", root] });
        try {
          const tree = await ready(root);
          expect(Object.values(tree).every(running)).toBe(true);

          owner.child.kill(signal);
          await owner.exited;

          await expectTreeStopped(tree);
        } finally {
          owner.child.kill("SIGKILL");
          await owner.exited;
        }
      });
    },
  );

  test("невозможный запуск отличается от ненулевого exit выполненной команды", async () => {
    await withGuardianFixture(async ({ options, root }) => {
      const action = runGuardedCommand({ ...options, argv: [join(root, "missing-command")] });

      await expect(action).rejects.toMatchObject({ reason: "spawn" });
    });
  });

  test("отсутствующий бинарник guardian возвращает типизированный отказ запуска", async () => {
    await withGuardianFixture(async ({ options, root }) => {
      const action = runGuardedCommand({ ...options, component: [join(root, "missing-guardian")] });

      await expect(action).rejects.toMatchObject({ reason: "spawn" });
    });
  });

  test.skipIf(process.platform === "darwin")(
    "Linux subreaper и Windows job очищают setsid/detached-потомков после обычного exit Git",
    async () => {
      await withGuardianFixture(async ({ options, actor, root }) => {
        const completion = runGuardedCommand({
          ...options,
          argv: [...actor, "tree-detached", root],
        });
        const tree = await ready(root);
        expect(Object.values(tree).every(running)).toBe(true);

        writeFileSync(join(root, "release"), "exit");
        const result = await completion;

        expect(result.code).toBe(0);
        await expectTreeStopped(tree);
      });
    },
  );

  test.skipIf(process.platform === "darwin")(
    "SIGKILL владельца очищает два уровня setsid/detached-потомков до конца теста",
    async () => {
      await withGuardianFixture(async ({ options, actor, root }) => {
        const owner = startOwner(root, { ...options, argv: [...actor, "tree-detached", root] });
        try {
          await withOwnerObservation(root, owner, async (phase) => {
            const tree = await ready(root);
            expect(Object.values(tree).every(running)).toBe(true);

            phase("owner-exit");
            owner.child.kill("SIGKILL");
            await owner.exited;

            phase("tree-stop");
            await expectTreeStopped(tree);
          });
        } finally {
          owner.child.kill("SIGKILL");
          await owner.exited;
        }
      });
    },
  );

  test.skipIf(process.platform !== "linux")(
    "SIGKILL владельца очищает detached-дерево даже при пропуске усыновлённых детей в procfs",
    async () => {
      await withGuardianFixture(async ({ options, actor, root }) => {
        const owner = startOwner(root, {
          ...options,
          component: [process.execPath, linuxProcfsEntry, root],
          argv: [...actor, "tree-detached", root],
        });
        try {
          await withOwnerObservation(root, owner, async (phase) => {
            const tree = await ready(root);
            const anchorStat = readFileSync(`/proc/${tree.anchor}/stat`, "utf8");
            const guardian = Number(
              anchorStat.slice(anchorStat.lastIndexOf(")") + 2).split(" ")[1],
            );
            expect(Object.values(tree).every(running)).toBe(true);
            writeFileSync(join(root, "procfs-arm.json"), JSON.stringify(tree));

            phase("owner-exit");
            owner.child.kill("SIGKILL");
            await owner.exited;
            phase("tree-stop");
            const fault = join(root, "procfs-omitted.json");
            await observe(
              () => existsSync(fault) && JSON.parse(readFileSync(fault, "utf8")).scans === 2,
              1000,
            );
            expect(JSON.parse(readFileSync(fault, "utf8"))).toEqual({
              scans: 2,
              branch: tree.branch,
              parent: guardian,
            });

            await observe(() => Object.values(tree).every((pid) => !running(pid)), 1500);
            await expectTreeStopped(tree);
          });
        } finally {
          owner.child.kill("SIGKILL");
          await owner.exited;
        }
      });
    },
  );

  test.each([
    { mode: "base64", reason: "protocol", name: "повреждённый base64" },
    { mode: "trailing", reason: "protocol", name: "данные после единственного frame" },
    { mode: "exit", reason: "guardian", name: "неуспешный exit самого guardian" },
  ])("$name не принимается за результат внешней команды", async ({ mode, reason }) => {
    await withGuardianFixture(async ({ options }) => {
      const completion = runGuardedCommand({
        ...options,
        component: [process.execPath, brokenEntry, mode],
      });

      await expect(completion).rejects.toMatchObject({ reason });
    });
  });

  test("лишние байты управляющего lease отклоняются и очищают уже запущенное дерево", async () => {
    await withGuardianFixture(async ({ options, actor, root, component }) => {
      const [executable, ...args] = component;
      if (!executable) {
        throw new Error("Не указан бинарник guardian");
      }
      const child = spawn(executable, [...args, "--guarded-command"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const output = new Response(child.stdout).arrayBuffer();
      const stderr = new Response(child.stderr).text();
      const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
      try {
        child.stdin.write(
          encodeFrame(createRequest({ ...options, argv: [...actor, "tree", root] })),
        );
        const tree = await ready(root);

        child.stdin.write(Buffer.from([1]));
        const code = await closed;
        const response = Buffer.from(await output);

        expect(code).toBe(0);
        expect(await stderr).toBe("");
        expect(response.readUInt32BE()).toBe(response.length - 4);
        expect(JSON.parse(response.subarray(4).toString())).toEqual({
          version: 1,
          kind: "failure",
          reason: "protocol",
          stdout: "",
          stderr: "",
        });
        await expectTreeStopped(tree);
      } finally {
        child.stdin.end();
        child.kill("SIGKILL");
        await closed;
      }
    });
  });
});
