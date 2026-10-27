import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { targets } from "../verification/catalog";
import { artifactDigest, prepareArtifactWorkspace, runArtifactTar } from "./artifacts-archive";
import { withArtifactFixture, writeArtifactFixtureFile } from "./artifacts-fixture";
import { artifactName } from "./artifacts-metadata";
import type { ArtifactContext, ArtifactManifest } from "./artifacts.types";
import { findReleaseRun, selectReleaseRunArtifacts } from "./release-api";
import { bundleRelease } from "./release-bundle";
import {
  isSuccessfulReleaseCi,
  releaseBuildArtifacts,
  requiredReleaseNames,
  selectReleaseArtifacts,
  validateReleaseVersions,
} from "./release-plan";
import type { ReleaseApi, ReleaseArtifact, ReleaseRun } from "./release.types";

const sha = "a".repeat(40);
const now = Date.parse("2026-10-27T12:00:00Z");
const source = { repository: "owner/relay", sha };
const expectedNames = [
  `cli-linux-x64-${sha}`,
  `server-linux-x64-${sha}`,
  `git-sync-linux-x64-${sha}`,
  `cli-windows-x64-${sha}`,
  `server-windows-x64-${sha}`,
  `git-sync-windows-x64-${sha}`,
  `cli-macos-arm64-${sha}`,
  `server-macos-arm64-${sha}`,
  `git-sync-macos-arm64-${sha}`,
] as const;
const completeArtifacts: readonly ReleaseArtifact[] = expectedNames.map((name, index) => ({
  id: index + 1,
  name,
  expired: false,
  expiresAt: now + 60_000,
}));
const validRun: ReleaseRun = {
  id: 42,
  sha,
  workflow: ".github/workflows/ci.yml",
  status: "completed",
  conclusion: "success",
};
const ineligibleRuns = [
  { name: "другой SHA", patch: { sha: "b".repeat(40) } },
  { name: "другой workflow", patch: { workflow: ".github/workflows/manual.yml" } },
  { name: "неоконченное выполнение", patch: { status: "in_progress", conclusion: null } },
  { name: "упавший CI", patch: { conclusion: "failure" } },
];
const incompleteArtifacts = [
  { name: "отсутствующий target", artifacts: completeArtifacts.slice(0, -1) },
  {
    name: "признак expired",
    artifacts: completeArtifacts.map((artifact) => ({ ...artifact, expired: true })),
  },
  {
    name: "истёкшая дата retention",
    artifacts: completeArtifacts.map((artifact) => ({ ...artifact, expiresAt: now })),
  },
  {
    name: "другой SHA в имени",
    artifacts: completeArtifacts.map((artifact) => ({
      ...artifact,
      name: artifact.name.replace(sha, "b".repeat(40)),
    })),
  },
  {
    name: "неоднозначный дубликат",
    artifacts: [
      ...completeArtifacts,
      { id: 99, name: expectedNames[0], expired: false, expiresAt: now + 60_000 },
    ],
  },
];
const invalidTags = [
  { tag: "v01.2.3" },
  { tag: "v1.2.3-01" },
  { tag: "v1.2.3-rc..1" },
  { tag: "v1.2.3+" },
  { tag: "v1.2.3/other" },
];

/**
 * Возвращает wire-карточки API из независимых проверенных тестовых данных.
 */
function artifactResponse(artifacts: readonly ReleaseArtifact[]): unknown {
  return {
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id,
      name: artifact.name,
      expired: artifact.expired,
      expires_at: new Date(artifact.expiresAt).toISOString(),
    })),
  };
}

/**
 * Создаёт настоящие tar fixtures всех ОС; их текстовые binaries не исполняются.
 * Metadata намеренно моделирует output других hosts для проверки кроссплатформенной поставки.
 */
async function createReleaseBundles(context: ArtifactContext, downloads: string): Promise<void> {
  for (const target of targets) {
    for (const artifact of releaseBuildArtifacts()) {
      const basename = artifact.id === "cli" ? "relay" : `relay-${artifact.id}`;
      const name = target.platform === "win32" ? `${basename}.exe` : basename;
      const fixtureRoot = join(context.root, "synthetic-builds", target.id);
      await writeArtifactFixtureFile(
        join(fixtureRoot, artifact.directory, name),
        `${target.id}/${artifact.id}\n`,
        0o755,
      );
      const path = await prepareArtifactWorkspace(
        context.root,
        join(downloads, artifactName(artifact, target.id, context.sha)),
      );
      const archive = join(path, "payload.tar");
      await runArtifactTar([
        "--format=ustar",
        "-cf",
        archive,
        "-C",
        fixtureRoot,
        artifact.directory,
      ]);
      const manifest: ArtifactManifest = {
        version: 1,
        id: artifact.id,
        component: artifact.component,
        target: target.id,
        sha: context.sha,
        ...context.toolchain,
        directory: artifact.directory,
        sha256: await artifactDigest(archive),
      };
      await writeFile(join(path, "manifest.json"), JSON.stringify(manifest));
    }
  }
}

describe("Источник release", () => {
  test("поставка требует три бинарника для каждого закреплённого target без SDK и Web", () => {
    const names = requiredReleaseNames(sha);

    expect(names).toEqual(expectedNames);
  });

  test.each(ineligibleRuns)("$name не подменяет успешный ci.yml того же SHA", ({ patch }) => {
    const eligible = isSuccessfulReleaseCi({ ...validRun, ...patch }, sha);

    expect(eligible).toBe(false);
  });

  test("полный набор с неистёкшим сроком хранения выбирается по точным ID, без журналов", () => {
    const log = { id: 999, name: "ci-logs", expired: false, expiresAt: now + 60_000 };

    const selected = selectReleaseArtifacts([log, ...completeArtifacts], sha, now);

    expect(selected).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test.each(incompleteArtifacts)(
    "$name требует fallback CI вместо неполной поставки",
    ({ artifacts }) => {
      const selected = selectReleaseArtifacts(artifacts, sha, now);

      expect(selected).toBeNull();
    },
  );

  test("поиск пропускает неполный run и находит бинарники за первой страницей журналов", async () => {
    const calls: string[] = [];
    const logs = Array.from({ length: 100 }, (_, index) => ({
      id: index + 100,
      name: `log-${index}`,
      expired: false,
      expiresAt: now + 60_000,
    }));
    /**
     * Моделирует две страницы artifacts второго run, сохраняя реальные URL-границы API.
     */
    const api: ReleaseApi = async (path) => {
      calls.push(path);
      if (path.includes("/workflows/ci.yml/runs?")) {
        return {
          workflow_runs: [
            {
              id: 41,
              head_sha: sha,
              path: ".github/workflows/ci.yml",
              status: "completed",
              conclusion: "success",
            },
            {
              id: 42,
              head_sha: sha,
              path: ".github/workflows/ci.yml",
              status: "completed",
              conclusion: "success",
            },
          ],
        };
      }
      if (path.includes("/runs/41/artifacts?")) {
        return artifactResponse(completeArtifacts.slice(0, -1));
      }
      return artifactResponse(path.endsWith("page=1") ? logs : completeArtifacts);
    };

    const runId = await findReleaseRun(source, api, now);

    expect(runId).toBe(42);
    expect(calls).toEqual([
      `/repos/owner/relay/actions/workflows/ci.yml/runs?head_sha=${sha}&status=success&per_page=100&page=1`,
      "/repos/owner/relay/actions/runs/41/artifacts?per_page=100&page=1",
      "/repos/owner/relay/actions/runs/42/artifacts?per_page=100&page=1",
      "/repos/owner/relay/actions/runs/42/artifacts?per_page=100&page=2",
    ]);
  });

  test("отказ GitHub API не маскируется отсутствием artifacts и скрытой пересборкой", async () => {
    const failure = new Error("API unavailable");
    /**
     * Внедряет сетевой отказ до получения списка run.
     */
    const api: ReleaseApi = async () => {
      throw failure;
    };

    await expect(findReleaseRun(source, api, now)).rejects.toBe(failure);
  });

  test("fallback получает artifacts текущего release run, не ожидая завершения самого publish", async () => {
    /**
     * Reusable CI уже прошёл, но вызывающий release run остаётся in_progress.
     */
    const api: ReleaseApi = async (path) =>
      path.includes("/artifacts?")
        ? artifactResponse(completeArtifacts)
        : {
            id: 55,
            head_sha: sha,
            path: ".github/workflows/release.yml",
            status: "in_progress",
            conclusion: null,
          };

    const ids = await selectReleaseRunArtifacts(source, 55, 55, api, now);

    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await expect(selectReleaseRunArtifacts(source, 55, 56, api, now)).rejects.toThrow(
      "Release требует успешный ci.yml",
    );
  });

  test("успешный внешний CI разрешает загрузку выбранных artifact IDs", async () => {
    /**
     * Источник остаётся завершённым и успешным на протяжении выбора artifacts.
     */
    const api: ReleaseApi = async (path) =>
      path.includes("/artifacts?")
        ? artifactResponse(completeArtifacts)
        : {
            id: 42,
            head_sha: sha,
            path: ".github/workflows/ci.yml",
            status: "completed",
            conclusion: "success",
          };

    const ids = await selectReleaseRunArtifacts(source, 42, 99, api, now);

    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("rerun producer во время выбора artifacts не выдаёт ещё не проверенные IDs для release", async () => {
    let restarted = false;
    /**
     * Первый GET видит успешный run; к чтению artifacts новый attempt уже заменил bundles.
     * Его зависимые тесты ещё выполняются, поэтому прежнего success недостаточно.
     */
    const api: ReleaseApi = async (path) => {
      if (path.includes("/artifacts?")) {
        restarted = true;
        return artifactResponse(completeArtifacts);
      }
      return {
        id: 42,
        head_sha: sha,
        path: ".github/workflows/ci.yml",
        status: restarted ? "in_progress" : "completed",
        conclusion: restarted ? null : "success",
      };
    };

    await expect(selectReleaseRunArtifacts(source, 42, 99, api, now)).rejects.toThrow(
      "Release требует успешный ci.yml",
    );
  });
});

describe("Согласованность выпуска", () => {
  test.each(invalidTags)(
    "некорректный SemVer $tag не публикуется даже при совпадении manifests",
    ({ tag }) => {
      const versions = [
        { path: "package.json", version: tag.slice(1) },
        { path: "apps/cli/package.json", version: tag.slice(1) },
      ];

      expect(() => validateReleaseVersions(tag, versions)).toThrow(
        "Тег должен иметь вид v<semver>",
      );
    },
  );

  test("версия prerelease точно совпадает с root и каждым приложением", () => {
    const version = validateReleaseVersions("v1.2.3-rc.1", [
      { path: "package.json", version: "1.2.3-rc.1" },
      { path: "apps/cli/package.json", version: "1.2.3-rc.1" },
      { path: "apps/web/package.json", version: "1.2.3-rc.1" },
    ]);

    expect(version).toBe("1.2.3-rc.1");
  });

  test("несовпавшая версия Web запрещает публикацию согласованных по имени бинарников", () => {
    const versions = [
      { path: "package.json", version: "1.2.3" },
      { path: "apps/cli/package.json", version: "1.2.3" },
      { path: "apps/web/package.json", version: "1.2.2" },
    ];

    expect(() => validateReleaseVersions("v1.2.3", versions)).toThrow("apps/web/package.json");
  });

  // Release публикуется с ubuntu-24.04; Windows FS не моделирует executable mode POSIX-бинарников.
  test.skipIf(process.platform === "win32")(
    "реальные tar bundles дают по три бинарника и проверяемые checksums без пересборки",
    async () => {
      await withArtifactFixture(async ({ context, downloads }) => {
        for (const path of [
          "package.json",
          "apps/cli/package.json",
          "apps/server/package.json",
          "apps/git-sync/package.json",
          "apps/web/package.json",
        ]) {
          await writeArtifactFixtureFile(
            join(context.root, path),
            JSON.stringify({ version: "1.2.3" }),
          );
        }
        await createReleaseBundles(context, downloads);
        const output = join(downloads, "..", "release-assets");

        const published = await bundleRelease(context, "v1.2.3", downloads, output);

        expect((await readdir(published)).sort()).toEqual([
          "SHA256SUMS",
          "relay-1.2.3-linux-x64.tar.gz",
          "relay-1.2.3-macos-arm64.tar.gz",
          "relay-1.2.3-windows-x64.tar.gz",
        ]);
        const checksums: string[] = [];
        for (const target of targets) {
          const filename = `relay-1.2.3-${target.id}.tar.gz`;
          const archive = join(published, filename);
          const listing = await runArtifactTar(["-tzf", archive]);
          const expected =
            target.id === "windows-x64"
              ? (["relay.exe", "relay-server.exe", "relay-git-sync.exe"] as const)
              : (["relay", "relay-server", "relay-git-sync"] as const);
          expect(listing.trim().split("\n")).toEqual([...expected]);
          const expectedContents = [
            { name: expected[0], content: `${target.id}/cli\n` },
            { name: expected[1], content: `${target.id}/server\n` },
            { name: expected[2], content: `${target.id}/git-sync\n` },
          ];
          for (const entry of expectedContents) {
            expect(await runArtifactTar(["-xOzf", archive, entry.name])).toBe(entry.content);
          }
          const bytes = await Bun.file(archive).arrayBuffer();
          checksums.push(
            `${createHash("sha256").update(Buffer.from(bytes)).digest("hex")}  ${filename}`,
          );
        }
        expect(await Bun.file(join(published, "SHA256SUMS")).text()).toBe(
          `${checksums.join("\n")}\n`,
        );
        expect(await Bun.file(join(context.root, "apps/cli/dist/relay")).exists()).toBe(false);
      });
    },
  );
});
