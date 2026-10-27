import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { probeGitSyncSupervisor, readGitSyncControlEndpoint } from "@relay/project-runtime";
import { failureDiagnostic, type NativeCommands } from "./native-command";
import type { NativeConfiguration } from "./native-service.types";
import { readWindowsFailureSnapshot } from "./windows/registration";
import { linuxFailureObservations } from "./linux/failure-snapshot";
import { macosFailureObservations } from "./macos/failure-snapshot";
import { observe } from "./native-observation";

/**
 * Сужает JSON на границе диагностического чтения без утверждения прикладного контракта.
 */
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Копирует только технические поля fatal-record, даже если в файле появились лишние payload-поля.
 * Неизвестный формат и произвольные строки не превращаются в dump сообщения, env или credentials.
 */
function safeSupervisorFailure(value: unknown): unknown {
  if (
    !object(value) ||
    value.version !== 1 ||
    value.kind !== "supervisor-failure" ||
    typeof value.attemptId !== "string" ||
    !/^[0-9a-f-]{36}$/u.test(value.attemptId) ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    typeof value.observedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.observedAt) ||
    !Array.isArray(value.causes) ||
    value.causes.length > 6
  ) {
    throw new Error("Неподдержанный формат fatal-record");
  }
  const causes = value.causes.map((cause: unknown) => {
    if (
      !object(cause) ||
      !(
        cause.code === null ||
        (typeof cause.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(cause.code))
      ) ||
      ![cause.exitCode, cause.errno, cause.win32Code].every(
        (code) => code === null || (typeof code === "number" && Number.isSafeInteger(code)),
      )
    ) {
      throw new Error("Неподдержанный формат технической причины");
    }
    return {
      code: cause.code,
      exitCode: cause.exitCode,
      errno: cause.errno,
      win32Code: cause.win32Code,
    };
  });
  return {
    version: 1,
    kind: "supervisor-failure",
    attemptId: value.attemptId,
    pid: value.pid,
    observedAt: value.observedAt,
    causes,
  };
}

/**
 * Считывает только bounded fatal-records из изолированного home fixture до его удаления.
 * Не открывает SQLite/mutex и не импортирует исходники приложения; чужие имена/ссылки не читаются.
 */
export function readSupervisorFailures(home: string): unknown {
  const directory = join(home, "git-sync");
  const files = readdirSync(directory)
    .filter((name) => /^supervisor-failure-(?:0\d|1[0-5])\.json$/u.test(name))
    .sort()
    .slice(0, 16);
  return files.map((file) => {
    try {
      const path = join(directory, file);
      const entry = lstatSync(path);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 8192) {
        return { file, readError: "Неподдержанный тип или размер диагностического файла" };
      }
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      return { file, value: safeSupervisorFailure(value) };
    } catch {
      // Повреждённый ранний slot не скрывает более позднюю причину; raw bytes не попадают в ошибку.
      return { file, readError: "Диагностический файл недоступен или повреждён" };
    }
  });
}

/**
 * До disable сохраняет bounded readonly-наблюдения своего manager и sanitized endpoint.
 * Не повторяет мутации, не запускает supervisor и не меняет состояние системных журналов.
 */
export async function captureNativeFailure(
  commands: NativeCommands,
  config: NativeConfiguration,
  binary: string,
  version: string,
  stage: string,
  error: unknown,
): Promise<void> {
  const observations = [
    observe("installed-configuration", () =>
      readFileSync(config.path, config.platform === "win32" ? "utf16le" : "utf8"),
    ),
    observe("control-endpoint", () => {
      const endpoint = readGitSyncControlEndpoint(join(config.home, "git-sync/supervisor.json"));
      if (!endpoint) {
        return null;
      }
      const { capability: _capability, ...publicEndpoint } = endpoint;
      return publicEndpoint;
    }),
    observe("health", () => probeGitSyncSupervisor(config.home, { version, timeoutMs: 2000 })),
    observe("supervisor-failures", () => readSupervisorFailures(config.home)),
  ];
  if (config.platform === "linux") {
    observations.push(...linuxFailureObservations(commands, config));
  } else if (config.platform === "win32") {
    observations.push(
      observe("task-scheduler", () => readWindowsFailureSnapshot(commands, config, binary)),
    );
  } else {
    observations.push(...macosFailureObservations(commands, config));
  }
  writeFileSync(
    join(commands.directory, `failure-${stage}.json`),
    JSON.stringify(
      {
        stage,
        capturedAt: new Date().toISOString(),
        error: failureDiagnostic(error),
        observations: await Promise.all(observations),
      },
      null,
      2,
    ),
  );
}
