import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GuardedCommandOptions } from "@relay/project-runtime";
import type { CommandOwner, GuardianFixture, TreeReady } from "./fixture.types";

const repository = fileURLToPath(new URL("../../../../..", import.meta.url));
const actorPath = fileURLToPath(new URL("./actor.ts", import.meta.url));
const ownerPath = fileURLToPath(new URL("./owner.ts", import.meta.url));

/**
 * Наблюдает реальное условие до deadline; короткая пауза ограничивает частоту наблюдений.
 */
export async function observe(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() >= deadline) {
      throw new Error("Не достигнут процессный барьер до deadline");
    }
    await Bun.sleep(10);
  }
}

/**
 * Отличает исполняющийся процесс от завершённого zombie, не отправляя ему сигналы завершения.
 */
export function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Читает барьер только после атомарной публикации файла самим процессным актором.
 */
export async function ready(root: string): Promise<TreeReady> {
  const path = join(root, "tree.ready");
  await observe(() => existsSync(path));
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    value === null ||
    typeof value !== "object" ||
    !("command" in value) ||
    typeof value.command !== "number" ||
    !("anchor" in value) ||
    typeof value.anchor !== "number" ||
    !("branch" in value) ||
    typeof value.branch !== "number" ||
    !("leaf" in value) ||
    typeof value.leaf !== "number"
  ) {
    throw new Error("Повреждён PID-барьер процессной fixture");
  }
  return { command: value.command, anchor: value.anchor, branch: value.branch, leaf: value.leaf };
}

/**
 * Создаёт собственное окружение; аварийная очистка вызывается лишь после assert сценария.
 * При отказе очистки сохраняет обе причины в AggregateError; успешная очистка не меняет primary.
 * Каталог удаляется только после подтверждённой остановки акторов.
 */
export async function withGuardianFixture(
  operation: (fixture: GuardianFixture) => Promise<void>,
): Promise<void> {
  const artifacts = process.env.CI_LOG_DIR
    ? resolve(repository, process.env.CI_LOG_DIR, "guardian-fixtures")
    : join(
        repository,
        ".artifacts",
        new Date().toISOString().slice(0, 10),
        "git-sync-implementation",
        "guardian",
        "fixtures",
      );
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "case-"));
  const home = join(root, "home");
  mkdirSync(home);
  const binary =
    process.env.RELAY_GUARDIAN_TEST_BINARY ??
    join(
      repository,
      "apps",
      "git-sync",
      "dist",
      process.platform === "win32" ? "relay-git-sync.exe" : "relay-git-sync",
    );
  const component = [binary];
  const actor = [process.execPath, actorPath];
  let operationFailed = false;
  let operationFailure: unknown;
  try {
    await operation({
      root,
      component,
      actor,
      options: {
        component,
        argv: [...actor, "echo"],
        cwd: root,
        env: { ...process.env, HOME: home, USERPROFILE: home },
        timeoutMs: 10_000,
        maxOutputBytes: 1024 * 1024,
      },
    });
  } catch (error) {
    operationFailed = true;
    operationFailure = error;
  }
  try {
    if (existsSync(join(root, "tree.ready"))) {
      const tree = await ready(root);
      // Аварийные барьеры адресуют только собственных акторов, без сигналов по сохранённым PID.
      writeFileSync(join(root, "stop"), "stop");
      writeFileSync(join(root, "release"), "exit");
      await observe(() => Object.values(tree).every((pid) => !running(pid)), 1000);
    }
    rmSync(root, { recursive: true, force: true });
  } catch (cleanupFailure) {
    if (operationFailed) {
      throw new AggregateError(
        [operationFailure, cleanupFailure],
        "Сценарий и очистка guardian fixture завершились с ошибками",
        { cause: operationFailure },
      );
    }
    throw cleanupFailure;
  }
  if (operationFailed) {
    throw operationFailure;
  }
}

/**
 * Запускает владельца в отдельном процессе; stdout/stderr читаются сразу, без --no-orphans.
 */
export function startOwner(root: string, options: GuardedCommandOptions): CommandOwner {
  const config = join(root, "owner.json");
  writeFileSync(config, JSON.stringify(options));
  const child = spawn(process.execPath, [ownerPath, config], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout.resume();
  child.stderr.resume();
  return {
    child,
    exited: new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => resolve());
    }),
  };
}
