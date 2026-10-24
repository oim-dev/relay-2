import { isGitSyncWorkspace, readGitSyncWorkspaceStatus } from "@relay/project-runtime";
import { RelayError, type GitSyncRequest } from "@relay/contracts";
import type { LocalInvocation } from "../../execution/local-invocation";
import type { CommandRegistry } from "../../execution/registry";
import { CliUsageError, describeCliFailure } from "../../errors/errors";
import { flag, integer, positional, string } from "../../input/arguments";
import { gitSyncCommandMessages as messages } from "../../locales/commands/git-sync";
import { result } from "../../output/output";
import type { Result } from "../../output/output.types";
import { gitSyncClient } from "./client";
import { readGitSyncWaitInput, readResolutionInput, readRestoreInput } from "./input";

const waitArgs = {
  "request-id": string(messages.requestId),
  "wait-ms": integer(messages.waitMs, 1, 90_000),
};

/**
 * Вызывает процессный протокол с исходными параметрами выбора проекта, без открытия БД CLI.
 */
async function request(
  invocation: LocalInvocation,
  action: string,
  input?: Record<string, unknown>,
): Promise<Result> {
  try {
    return result(
      await gitSyncClient(invocation).request({
        version: 1,
        action,
        options: invocation.options,
        ...(input ? { input } : {}),
      }),
    );
  } catch (cause) {
    if (cause instanceof RelayError && typeof cause.details?.requestId === "string") {
      const error = new RelayError(
        cause.code,
        messages.requestFailure(cause.message, cause.details.requestId),
        cause.exitCode,
        cause.details,
      );
      error.cause = cause;
      throw error;
    }
    throw cause;
  }
}

/**
 * Выбирает одиночный статус либо полный workspace, сохраняя каждую ошибочную регистрацию.
 * Отказ выбранного проекта остаётся элементом items; исходная ошибка управляет общим exit code.
 */
async function status(invocation: LocalInvocation): Promise<Result> {
  const all = invocation.values.all === true;
  const options = invocation.options;
  const wait = readGitSyncWaitInput(invocation.values);
  const refresh = invocation.values.refresh === true;
  if (!refresh && (wait.requestId !== undefined || wait.waitMs !== undefined)) {
    throw new CliUsageError(messages.waitRequiresRefresh);
  }
  if (all && options.project !== undefined) {
    throw new CliUsageError(messages.allAndProject);
  }
  if (all || (options.project === undefined && isGitSyncWorkspace(options))) {
    if (wait.requestId !== undefined) {
      throw new CliUsageError(messages.waitRequiresProject);
    }
    const client = gitSyncClient(invocation);
    const waitMs = wait.waitMs;
    const statusClient =
      waitMs === undefined
        ? client
        : {
            ...client,
            /**
             * Применяет одинаковый budget к отдельным запросам регистраций, сохраняя независимые operationId Runtime.
             */
            request: (value: GitSyncRequest): Promise<unknown> =>
              client.request({ ...value, input: { ...value.input, waitMs } }),
          };
    const data = await readGitSyncWorkspaceStatus(statusClient, options, refresh);
    const firstFailure = data.items.find((item) => !item.ok);
    return {
      data,
      ...(firstFailure && !firstFailure.ok
        ? {
            failure: {
              ...firstFailure.error,
              invalidInput: false,
              message: messages.partialStatus,
            },
          }
        : {}),
    };
  }
  const identity = { name: options.project ?? null, path: null };
  try {
    const single = await request(invocation, "status", {
      refresh,
      ...wait,
    });
    return result({
      version: 1,
      scope: "project",
      items: [{ ...identity, ok: true, data: single.data }],
    });
  } catch (cause) {
    const failure = describeCliFailure(cause);
    const { invalidInput: _invalidInput, ...error } = failure;
    return {
      data: { version: 1, scope: "project", items: [{ ...identity, ok: false, error }] },
      failure,
    };
  }
}

/**
 * Регистрирует только relay git-sync: все долгие действия проходят отдельную async local-границу.
 */
export function registerGitSyncCommands(registry: CommandRegistry): void {
  registry.group("git-sync", messages.group);
  registry.addProcess("git-sync connect", {
    ...messages.connect,
    args: { remote: string(messages.remote, true), branch: string(messages.branch) },
    /**
     * Передаёт remote/branch буквально; интерпретацией Git-адреса владеет компонент.
     */
    run: (i): Promise<Result> =>
      request(i, "connect", {
        remote: i.text("remote"),
        ...(i.values.branch !== undefined ? { branch: i.text("branch") } : {}),
      }),
  });
  registry.addProcess("git-sync status", {
    ...messages.status,
    args: { refresh: flag(messages.refresh), all: flag(messages.all), ...waitArgs },
    presentation: "git-sync-status",
    run: status,
  });
  registry.addProcess("git-sync now", {
    ...messages.now,
    args: waitArgs,
    presentation: "git-sync-status",
    /**
     * Ожидает один процессный сценарий обмена; предметные мутации CLI сюда не обращаются.
     */
    run: (i): Promise<Result> => {
      const input = readGitSyncWaitInput(i.values);
      return request(i, "now", Object.keys(input).length ? { ...input } : undefined);
    },
  });
  registry.group("git-sync request", messages.request);
  registry.addProcess("git-sync request get", {
    ...messages.requestGet,
    args: { "request-id": positional(messages.requestId) },
    presentation: "git-sync-status",
    /**
     * Читает bounded outcome по ID без submit; unknown остаётся unknown в исходном DTO.
     */
    run: (i): Promise<Result> => request(i, "request.get", { ...readGitSyncWaitInput(i.values) }),
  });
  registry.group("git-sync auto", messages.auto);
  registry.group("git-sync worker", messages.worker);
  for (const [path, action, help] of [
    ["auto enable", "auto.enable", messages.autoEnable],
    ["auto disable", "auto.disable", messages.autoDisable],
    ["worker start", "worker.start", messages.workerStart],
    ["worker stop", "worker.stop", messages.workerStop],
    ["worker restart", "worker.restart", messages.workerRestart],
  ] as const) {
    registry.addProcess(`git-sync ${path}`, {
      ...help,
      /**
       * Передаёт lifecycle выбранного проекта единственному владельцу Git Sync.
       */
      run: (i): Promise<Result> => request(i, action),
    });
  }
  registry.group("git-sync conflicts", messages.conflicts);
  registry.addProcess("git-sync conflicts list", {
    ...messages.conflictsList,
    presentation: "git-sync-status",
    /**
     * Читает действительные конфликты и отдельную pending-диагностику dependencies через компонент.
     */
    run: (i): Promise<Result> => request(i, "conflicts.list"),
  });
  registry.addProcess("git-sync conflicts get", {
    ...messages.conflictsGet,
    args: { id: positional(messages.id) },
    presentation: "git-sync-status",
    /**
     * Сохраняет адрес выбранного конфликта без преобразования его материалов.
     */
    run: (i): Promise<Result> => request(i, "conflicts.get", { id: i.text("id") }),
  });
  registry.addProcess("git-sync conflicts resolve", {
    ...messages.conflictsResolve,
    args: { id: positional(messages.id), input: string(messages.input, true) },
    readInput: readResolutionInput,
    presentation: "git-sync-status",
    /**
     * Автор и ID адресуются вне объекта решения; пользовательский JSON сохраняется дословно.
     */
    run: (i): Promise<Result> =>
      request(i, "conflicts.resolve", { id: i.text("id"), decision: i.input, actor: i.actor }),
  });
  registry.addProcess("git-sync restore", {
    ...messages.restore,
    args: {
      remote: string(messages.remote),
      branch: string(messages.branch),
      resume: flag(messages.resume),
      "project-id": string(messages.resumeProjectId),
    },
    /**
     * Передаёт отдельно новый snapshot либо local resume; выбор ID и состояние intent принадлежат Runtime.
     */
    run: (i): Promise<Result> => request(i, "restore", readRestoreInput(i.values)),
  });
  registry.group("git-sync service", messages.service);
  for (const [action, help] of [
    ["enable", messages.serviceEnable],
    ["disable", messages.serviceDisable],
    ["status", messages.serviceStatus],
  ] as const) {
    registry.addProcess(`git-sync service ${action}`, {
      ...help,
      presentation: "git-sync-status",
      /**
       * Native service lifecycle принадлежит Runtime и не открывает проектную БД.
       */
      run: async (i): Promise<Result> => result(await gitSyncClient(i).service(action, i.options)),
    });
  }
  registry.addProcess("git-sync supervise", {
    ...messages.supervise,
    args: { home: string(messages.home) },
    /**
     * Ждёт foreground-процесс; сигналы и потоковый вывод подключены в process runtime.
     */
    run: async (i): Promise<Result> => {
      await gitSyncClient(i).supervise({
        ...i.options,
        ...(i.values.home !== undefined ? { home: i.text("home") } : {}),
      });
      return { data: null, silent: true };
    },
  });
}
