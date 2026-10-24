import { expect } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import {
  createGitSyncClient,
  createServiceConfiguration,
  gitSyncControlRelease,
  initializeProject,
  openProject,
  probeGitSyncSupervisor,
  type GitSyncClient,
  type GitSyncServiceAction,
  type GitSyncServiceStatus,
  type GitSyncSupervisorStatus,
  type ProjectLocation,
  type RuntimeOptions,
} from "@relay/project-runtime";
import manifest from "../../package.json";
import { failureDiagnostic, NativeCommands } from "./native-command";
import {
  nativeEnvironment,
  preflightNativeSession,
  readLinger,
  requireNativeServiceOptIn,
} from "./native-environment";
import { NativeManager } from "./native-manager";
import { captureNativeFailure } from "./native-failure-snapshot";
import { crashWindowsSupervisor } from "./native-windows";
import type {
  NativeConfiguration,
  NativePlatform,
  NativeSession,
  RunningSupervisor,
} from "./native-service.types";

const repository = resolve(import.meta.dir, "../../../..");

/**
 * Определяет исчезновение PID только чтением; ошибки прав не превращает в успешную уборку.
 */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

/**
 * Владеет одной native-регистрацией и изолированными файлами. Не заменяет manager, runner или health.
 * При отказе setup снимает уже начатую установку; аварийная уборка никогда не засчитывается как успех.
 */
export class NativeServiceFixture {
  /* Изолированные рабочие файлы, удаляемые только после остановки своей службы. */
  readonly data: string;
  /* Путь реального compiled Git Sync с пробелами и Unicode. */
  readonly binary: string;
  /* Явные cwd/home публичных Runtime-вызовов. */
  readonly options: RuntimeOptions & { readonly home: string };
  /* Точная версия поставки, используемая настоящим health-протоколом. */
  readonly version = manifest.version;
  /* Вычисленные ID/путь собственной службы до первой записи manager. */
  readonly config: NativeConfiguration;
  /* Независимый наблюдатель настоящего manager. */
  readonly manager: NativeManager;
  /* Публичный клиент без injected runner, serviceFiles и supervisorProbe. */
  private readonly client: GitSyncClient;
  /* Подтверждённые supervisor PID; после disable все должны исчезнуть до cleanup fixture. */
  private readonly pids = new Set<number>();
  /* Попытка enable началась после подготовки и доказанного отсутствия выбранного ID. */
  private armed = false;
  /* Настоящий локальный проект, который disable обязан сохранить. */
  private project: ProjectLocation | undefined;
  /* Побайтовый снимок БД после её закрытия. */
  private databaseBefore: Buffer<ArrayBuffer> | undefined;
  /* Побайтовый снимок привязки проекта. */
  private configBefore: Buffer<ArrayBuffer> | undefined;

  /**
   * Вычисляет адреса fixture без регистрации; prepare и cleanup вызываются внутри try/finally.
   */
  constructor(
    /* Каталог журналов и рабочего подкаталога fixture. */
    readonly directory: string,
    /* Проверенная реальная ОС runner. */
    private readonly platform: NativePlatform,
    /* Текущий пользователь и исходная политика login. */
    private readonly session: NativeSession,
    /* Независимые native-наблюдения и их журналы. */
    private readonly commands: NativeCommands,
  ) {
    this.data = join(directory, "fixture");
    const suffix = platform === "win32" ? ".exe" : "";
    const folder = platform === "win32" ? "бинарник Relay Ω" : 'бинарник "Relay" Ω';
    this.binary = join(this.data, folder, `relay-git-sync${suffix}`);
    this.options = { cwd: join(this.data, "проект"), home: join(this.data, "дом Relay Ω") };
    const identity = session.userName ? { userName: session.userName } : {};
    this.config = createServiceConfiguration({
      platform,
      binary: this.binary,
      home: this.options.home,
      userHome: session.userHome,
      ...identity,
    });
    this.manager = new NativeManager(commands, this.config, this.binary, session);
    this.client = createGitSyncClient({
      cwd: this.options.cwd,
      env: { ...commands.env, RELAY_HOME: this.options.home, RELAY_GIT_SYNC_BIN: this.binary },
      binary: this.binary,
      executablePath: process.execPath,
      version: this.version,
      userHome: session.userHome,
      readinessTimeoutMs: 30_000,
      ...identity,
    });
  }

  /**
   * Готовит только собственные файлы и реальный проект; проверяет отсутствие регистрации до enable.
   */
  async prepare(): Promise<void> {
    expect(existsSync(this.config.path)).toBe(false);
    await this.manager.assertAbsent();
    const suffix = this.platform === "win32" ? ".exe" : "";
    const source = join(repository, "apps/git-sync/dist", `relay-git-sync${suffix}`);
    if (!existsSync(source)) {
      throw new Error("NATIVE_SERVICE_BUILD_REQUIRED: сначала выполните bun run build:cli");
    }
    mkdirSync(dirname(this.binary), { recursive: true });
    mkdirSync(this.options.cwd, { recursive: true });
    copyFileSync(source, this.binary);
    this.project = initializeProject({
      ...this.options,
      name: "Сохранённый проект Ω",
      slug: "native-service",
    });
    this.databaseBefore = readFileSync(this.project.databasePath);
    this.configBefore = readFileSync(this.project.configPath);
    this.save("fixture", {
      config: this.config,
      project: this.project,
      binary: this.binary,
      session: this.session,
    });
  }

  /**
   * Вызывает проверяемый публичный Runtime и сохраняет полное наблюдение каждого этапа.
   */
  async service(action: GitSyncServiceAction, stage: string): Promise<GitSyncServiceStatus> {
    if (action === "enable") {
      this.armed = true;
    }
    this.save(`${stage}-attempt`, {
      action,
      startedAt: new Date().toISOString(),
      id: this.config.id,
    });
    let result: GitSyncServiceStatus;
    try {
      result = await this.client.service(action, this.options);
    } catch (error) {
      try {
        await captureNativeFailure(
          this.commands,
          this.config,
          this.binary,
          this.version,
          stage,
          error,
        );
      } catch (snapshotError) {
        throw new AggregateError(
          [error, snapshotError],
          "Не удалось сохранить диагностику native отказа",
        );
      }
      throw error;
    }
    if (result.supervisor.pid !== null) {
      this.pids.add(result.supervisor.pid);
    }
    this.save(stage, result);
    return result;
  }

  /**
   * Сопоставляет результат Runtime с новым реальным health и владельцем в native manager.
   */
  async verifyRunning(status: GitSyncSupervisorStatus): Promise<RunningSupervisor> {
    expect(status).toMatchObject({
      actual: "running",
      responsive: true,
      release: gitSyncControlRelease(this.version),
    });
    if (typeof status.pid !== "number" || typeof status.instance !== "string" || !status.instance) {
      throw new Error("Readiness не содержит настоящие PID и instance");
    }
    this.pids.add(status.pid);
    const health = await probeGitSyncSupervisor(this.options.home, { version: this.version });
    expect(health).toMatchObject({
      actual: "running",
      responsive: true,
      pid: status.pid,
      instance: status.instance,
    });
    await this.manager.assertRegistered(status.pid);
    return { ...status, pid: status.pid, instance: status.instance };
  }

  /**
   * Ожидает исчезновение конкретных предыдущих PID, не выполняя fixture kill.
   */
  async assertExited(pids: readonly number[]): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (pids.some(processExists)) {
      if (Date.now() >= deadline) {
        throw new Error(
          `Production cleanup оставила живые PID: ${pids.filter(processExists).join(", ")}`,
        );
      }
      await pause(50);
    }
  }

  /**
   * Проверяет production disable до удаления fixture: нет registration, файла, health и живых PID.
   */
  async assertDisabled(): Promise<void> {
    await this.manager.assertAbsent();
    expect(existsSync(this.config.path)).toBe(false);
    await this.assertExited([...this.pids]);
    const health = await probeGitSyncSupervisor(this.options.home, { version: this.version });
    this.save("disabled-health", health);
    expect(health.responsive).toBe(false);
    expect(health.actual).not.toBe("running");
  }

  /**
   * Проверяет целые сохранённые файлы и повторно открывает тот же предметный проект после disable.
   */
  assertProjectPreserved(): void {
    if (!this.project || !this.databaseBefore || !this.configBefore) {
      throw new Error("Fixture проекта не подготовлен");
    }
    expect(readFileSync(this.project.databasePath)).toEqual(this.databaseBefore);
    expect(readFileSync(this.project.configPath)).toEqual(this.configBefore);
    const opened = openProject(this.options);
    try {
      expect(opened.location).toEqual(this.project);
      expect(opened.database.get(this.project.projectId)).toMatchObject({
        id: this.project.projectId,
        data: { name: "Сохранённый проект Ω", slug: "native-service" },
      });
    } finally {
      opened.database.close();
    }
  }

  /**
   * Сохраняет диагностику без capability control endpoint и полного окружения пользователя.
   */
  save(stage: string, value: unknown): void {
    writeFileSync(join(this.directory, `${stage}.json`), JSON.stringify(value, null, 2));
  }

  /**
   * Всегда пытается отключить начатую установку, включая отказ enable/readiness.
   * Fallback убирает лишь свой ID и подтверждённый health-процесс, сохраняя исходную ошибку теста.
   */
  async dispose(): Promise<void> {
    const errors: unknown[] = [];
    if (this.armed) {
      try {
        // Enable мог завершиться ошибкой после запуска, не вернув PID вызывающему.
        const before = await probeGitSyncSupervisor(this.options.home, { version: this.version });
        if (before.pid !== null) {
          this.pids.add(before.pid);
        }
        await this.service("disable", "finally-disable");
        await this.assertDisabled();
      } catch (error) {
        errors.push(error);
        try {
          await this.emergencyCleanup();
        } catch (cleanupError) {
          errors.push(cleanupError);
        }
      }
    }
    if (this.session.linger !== null && this.session.uid !== null) {
      try {
        expect(await readLinger(this.commands, this.session.uid)).toBe(this.session.linger);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        "Native service fixture: production cleanup или политика login не прошли проверку",
      );
    }
    rmSync(this.data, { recursive: true, force: true });
  }

  /**
   * Пытается выполнить все этапы аварийной уборки даже после отказа manager.
   * PID для kill берётся только из живого ответа своего home/instance, а не из оставшегося файла.
   */
  private async emergencyCleanup(): Promise<void> {
    const errors: unknown[] = [];
    try {
      await this.manager.emergencyRemove();
    } catch (error) {
      errors.push(error);
    }
    try {
      const health = await probeGitSyncSupervisor(this.options.home, { version: this.version });
      if (health.responsive && health.pid !== null) {
        this.save("fixture-emergency-kill", health);
        this.pids.add(health.pid);
        if (this.platform === "win32") {
          await crashWindowsSupervisor(this.commands, this.binary, health.pid);
        } else {
          process.kill(health.pid, "SIGKILL");
        }
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.assertDisabled();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Аварийная уборка native fixture не завершена");
    }
  }
}

/**
 * Охватывает подготовку и сценарий общей finally-уборкой; журналы сохраняются после успеха и отказа.
 * Отказ preflight не вызывает ни установки, ни попытки удаления службы.
 */
export async function withNativeServiceFixture(
  operation: (fixture: NativeServiceFixture) => Promise<void>,
): Promise<void> {
  const platform = requireNativeServiceOptIn();
  const artifacts = join(
    repository,
    ".artifacts",
    new Date().toISOString().slice(0, 10),
    "git-sync-implementation/finalization/native-service-ci",
  );
  mkdirSync(artifacts, { recursive: true });
  const directory = realpathSync(mkdtempSync(join(artifacts, `${platform}-`)));
  const commands = new NativeCommands(directory, nativeEnvironment(platform));
  let fixture: NativeServiceFixture | undefined;
  const errors: unknown[] = [];
  try {
    const session = await preflightNativeSession(platform, commands);
    fixture = new NativeServiceFixture(directory, platform, session, commands);
    await fixture.prepare();
    await operation(fixture);
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      await fixture?.dispose();
    } catch (error) {
      errors.push(error);
    }
    writeFileSync(
      join(directory, "result.json"),
      JSON.stringify(
        {
          passed: errors.length === 0,
          errors: errors.map(failureDiagnostic),
          loginOrRebootTested: false,
        },
        null,
        2,
      ),
    );
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `Нативная приёмка не пройдена; журналы: ${directory}`);
  }
}
