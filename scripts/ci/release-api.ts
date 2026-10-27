import { isSuccessfulReleaseCi, selectReleaseArtifacts } from "./release-plan";
import { releaseMessages } from "./release.messages";
import type { ReleaseApi, ReleaseArtifact, ReleaseRun, ReleaseSource } from "./release.types";

/**
 * Создаёт read-only клиент GitHub REST API. HTTP-отказ не превращается в отсутствие CI.
 */
export function createReleaseApi(token: string, baseUrl: string): ReleaseApi {
  return async (path) => {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) {
      throw new Error(releaseMessages.api(response.status, path));
    }
    return response.json();
  };
}

/**
 * Декодирует минимальную идентичность run до принятия решения о доверии его результатам.
 */
export function decodeReleaseRun(value: unknown): ReleaseRun {
  if (
    value === null ||
    typeof value !== "object" ||
    !("id" in value) ||
    typeof value.id !== "number" ||
    !Number.isSafeInteger(value.id) ||
    value.id <= 0 ||
    !("head_sha" in value) ||
    typeof value.head_sha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value.head_sha) ||
    !("path" in value) ||
    typeof value.path !== "string" ||
    !("status" in value) ||
    typeof value.status !== "string" ||
    !("conclusion" in value) ||
    (value.conclusion !== null && typeof value.conclusion !== "string")
  ) {
    throw new Error(releaseMessages.response);
  }
  return {
    id: value.id,
    sha: value.head_sha,
    workflow: value.path,
    status: value.status,
    conclusion: value.conclusion,
  };
}

/**
 * Декодирует artifact и дату retention; некорректная дата не считается бесконечным сроком.
 */
export function decodeReleaseArtifact(value: unknown): ReleaseArtifact {
  if (
    value === null ||
    typeof value !== "object" ||
    !("id" in value) ||
    typeof value.id !== "number" ||
    !Number.isSafeInteger(value.id) ||
    value.id <= 0 ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !("expired" in value) ||
    typeof value.expired !== "boolean" ||
    !("expires_at" in value) ||
    typeof value.expires_at !== "string" ||
    !Number.isFinite(Date.parse(value.expires_at))
  ) {
    throw new Error(releaseMessages.response);
  }
  return {
    id: value.id,
    name: value.name,
    expired: value.expired,
    expiresAt: Date.parse(value.expires_at),
  };
}

/**
 * Читает страницу коллекции GitHub, сохраняя unknown до декодера конкретного ресурса.
 */
function responseCollection(value: unknown, key: string): readonly unknown[] {
  if (value === null || typeof value !== "object") {
    throw new Error(releaseMessages.response);
  }
  const entries: unknown = Reflect.get(value, key);
  if (!Array.isArray(entries)) {
    throw new Error(releaseMessages.response);
  }
  return entries;
}

/**
 * Перечисляет все artifacts run с пагинацией: журналы CI не вытесняют бинарники с первой страницы.
 */
export async function readReleaseArtifacts(
  source: ReleaseSource,
  runId: number,
  api: ReleaseApi,
): Promise<readonly ReleaseArtifact[]> {
  const artifacts: ReleaseArtifact[] = [];
  for (let page = 1; ; page += 1) {
    const response = await api(
      `/repos/${source.repository}/actions/runs/${runId}/artifacts?per_page=100&page=${page}`,
    );
    const entries = responseCollection(response, "artifacts");
    artifacts.push(...entries.map(decodeReleaseArtifact));
    if (entries.length < 100) {
      return artifacts;
    }
  }
}

/**
 * Ищет успешный ci.yml ровно данного SHA с полным неистёкшим набором бинарников.
 * Пустой результат разрешает workflow_call; HTTP/JSON-ошибка завершается отказом, не пересборкой.
 */
export async function findReleaseRun(
  source: ReleaseSource,
  api: ReleaseApi,
  now: number,
): Promise<number | null> {
  for (let page = 1; ; page += 1) {
    const response = await api(
      `/repos/${source.repository}/actions/workflows/ci.yml/runs?head_sha=${source.sha}&status=success&per_page=100&page=${page}`,
    );
    const entries = responseCollection(response, "workflow_runs");
    for (const entry of entries) {
      const run = decodeReleaseRun(entry);
      if (!isSuccessfulReleaseCi(run, source.sha)) {
        continue;
      }
      const artifacts = await readReleaseArtifacts(source, run.id, api);
      if (selectReleaseArtifacts(artifacts, source.sha, now)) {
        return run.id;
      }
    }
    if (entries.length < 100) {
      return null;
    }
  }
}

/**
 * Повторно проверяет источник перед download. Текущий release run может ещё выполняться:
 * его reusable CI уже обязан завершиться success по needs/if самого workflow.
 * Внешний CI перепроверяется после чтения IDs: параллельный rerun мог заменить bundles.
 * Дальнейшая загрузка использует именно эти неизменяемые IDs; их удаление не разрешает
 * переключиться на новые, ещё не проверенные artifacts с теми же именами.
 */
export async function selectReleaseRunArtifacts(
  source: ReleaseSource,
  runId: number,
  currentRunId: number,
  api: ReleaseApi,
  now: number,
): Promise<readonly number[]> {
  const runPath = `/repos/${source.repository}/actions/runs/${runId}`;
  const run = decodeReleaseRun(await api(runPath));
  const currentVerifiedRelease =
    run.id === currentRunId &&
    run.workflow === ".github/workflows/release.yml" &&
    run.sha === source.sha;
  if (run.id !== runId || (!currentVerifiedRelease && !isSuccessfulReleaseCi(run, source.sha))) {
    throw new Error(releaseMessages.run);
  }
  const ids = selectReleaseArtifacts(
    await readReleaseArtifacts(source, runId, api),
    source.sha,
    now,
  );
  if (!ids) {
    throw new Error(releaseMessages.artifacts);
  }
  if (!currentVerifiedRelease) {
    const confirmed = decodeReleaseRun(await api(runPath));
    if (confirmed.id !== runId || !isSuccessfulReleaseCi(confirmed, source.sha)) {
      throw new Error(releaseMessages.run);
    }
  }
  return ids;
}
