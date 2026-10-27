import { describe, expect, test } from "bun:test";
import { appendFile, lstat, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { buildArtifact, targets } from "../verification/catalog";
import {
  artifactDigest,
  runArtifactTar,
  validateArchiveEntries,
  validateArtifactArchive,
} from "./artifacts-archive";
import { withArtifactFixture, writeArtifactFixtureFile } from "./artifacts-fixture";
import { decodeArtifactManifest } from "./artifacts-metadata";
import { packArtifact, restoreArtifacts } from "./artifacts";

const metadataContext = {
  root: "/unused",
  sha: "a".repeat(40),
  toolchain: { bun: "1.4.3", node: "24.18.1" },
};
const validManifest = {
  version: 1,
  id: "cli",
  component: "cli",
  target: "linux-x64",
  sha: "a".repeat(40),
  bun: "1.4.3",
  node: "24.18.1",
  directory: "apps/cli/dist",
  sha256: "b".repeat(64),
} as const;
const mismatchedMetadata = [
  { name: "версия протокола", patch: { version: 2 } },
  { name: "ID артефакта", patch: { id: "server" } },
  { name: "компонент", patch: { component: "server" } },
  { name: "target", patch: { target: "windows-x64" } },
  { name: "SHA", patch: { sha: "c".repeat(40) } },
  { name: "Bun", patch: { bun: "1.0.0" } },
  { name: "Node.js", patch: { node: "22.0.0" } },
  { name: "output", patch: { directory: "apps/server/dist" } },
  { name: "формат hash", patch: { sha256: "not-a-sha256" } },
];
const unsafeEntries = [
  { name: "абсолютный путь", path: "/apps/cli/dist/file", type: 48 },
  { name: "переход к родителю", path: "apps/cli/dist/../file", type: 48 },
  { name: "чужой output", path: "apps/server/dist/file", type: 48 },
  { name: "node_modules", path: "apps/cli/dist/node_modules/module.js", type: 48 },
  { name: "символическая ссылка", path: "apps/cli/dist/link", type: 50 },
  { name: "жёсткая ссылка", path: "apps/cli/dist/link", type: 49 },
  { name: "специальный файл", path: "apps/cli/dist/pipe", type: 54 },
  { name: "путь Windows", path: "C:/apps/cli/dist/file", type: 48 },
  { name: "обратный разделитель", path: "apps/cli/dist/..\\file", type: 48 },
  { name: "устройство Windows", path: "apps/cli/dist/NUL.txt", type: 48 },
  { name: "неоднозначный пробел", path: "apps/cli/dist/file ", type: 48 },
  { name: "переопределение PAX", path: "apps/cli/dist/entry", type: 120 },
];

describe("Metadata передачи CI", () => {
  test("точная идентичность checkout декодируется без потери полей", () => {
    const manifest = decodeArtifactManifest(
      validManifest,
      buildArtifact("cli"),
      "linux-x64",
      metadataContext,
    );

    expect(manifest).toEqual(validManifest);
  });

  test.each(mismatchedMetadata)("несовпадение $name отклоняется до чтения архива", ({ patch }) => {
    const invalidManifest = { ...validManifest, ...patch };

    expect(() =>
      decodeArtifactManifest(invalidManifest, buildArtifact("cli"), "linux-x64", metadataContext),
    ).toThrow(expect.objectContaining({ code: "ARTIFACT_METADATA" }));
  });
});

describe("Граница tar", () => {
  test.each(unsafeEntries)("$name запрещён до распаковки", ({ path, type }) => {
    const entries = [
      { path: "apps/cli/dist/", type: 53, size: 0, mode: 0o755 },
      { path, type, size: 1, mode: 0o644 },
    ];

    expect(() => validateArchiveEntries(entries, "apps/cli/dist")).toThrow(
      expect.objectContaining({ code: "ARTIFACT_UNSAFE_ARCHIVE" }),
    );
  });

  test("повторная запись одного пути не перезаписывает проверенное содержимое", () => {
    const entries = [
      { path: "apps/cli/dist/", type: 53, size: 0, mode: 0o755 },
      { path: "apps/cli/dist/file", type: 48, size: 1, mode: 0o644 },
      { path: "apps/cli/dist/file", type: 48, size: 1, mode: 0o644 },
    ];

    expect(() => validateArchiveEntries(entries, "apps/cli/dist")).toThrow(
      expect.objectContaining({ code: "ARTIFACT_UNSAFE_ARCHIVE" }),
    );
  });

  test("неверный checksum заголовка не проходит проверку USTAR", async () => {
    await withArtifactFixture(async ({ context, downloads, target, cliBinary }) => {
      await writeArtifactFixtureFile(join(context.root, cliBinary), "compiled cli", 0o755);
      const packed = await packArtifact(context, "cli", target, downloads);
      const archive = join(packed.path, "payload.tar");
      const bytes = Buffer.from(await Bun.file(archive).arrayBuffer());
      // Повреждаем формат независимо от manifest: этот тест адресует непосредственно декодер tar.
      bytes[0] = 120;
      await writeFile(archive, bytes);

      await expect(validateArtifactArchive(archive, "apps/cli/dist")).rejects.toMatchObject({
        code: "ARTIFACT_UNSAFE_ARCHIVE",
      });
    });
  });

  test("обрезанный архив не проходит проверку USTAR", async () => {
    await withArtifactFixture(async ({ context, downloads, target, cliBinary }) => {
      await writeArtifactFixtureFile(join(context.root, cliBinary), "compiled cli", 0o755);
      const packed = await packArtifact(context, "cli", target, downloads);
      const archive = join(packed.path, "payload.tar");
      const bytes = Buffer.from(await Bun.file(archive).arrayBuffer());
      await writeFile(archive, bytes.subarray(0, 512));

      await expect(validateArtifactArchive(archive, "apps/cli/dist")).rejects.toMatchObject({
        code: "ARTIFACT_UNSAFE_ARCHIVE",
      });
    });
  });

  test("данные после завершающих блоков не проходят проверку USTAR", async () => {
    await withArtifactFixture(async ({ context, downloads, target, cliBinary }) => {
      await writeArtifactFixtureFile(join(context.root, cliBinary), "compiled cli", 0o755);
      const packed = await packArtifact(context, "cli", target, downloads);
      const archive = join(packed.path, "payload.tar");
      await appendFile(archive, Buffer.alloc(512, 120));

      await expect(validateArtifactArchive(archive, "apps/cli/dist")).rejects.toMatchObject({
        code: "ARTIFACT_UNSAFE_ARCHIVE",
      });
    });
  });
});

describe("Передача готовых output без пересборки", () => {
  test("native round-trip сохраняет байты и permissions, удаляя прежние файлы только output", async () => {
    await withArtifactFixture(async ({ context, downloads, target, cliBinary }) => {
      const binary = join(context.root, cliBinary);
      await writeArtifactFixtureFile(binary, "compiled cli\n", 0o751);
      await writeArtifactFixtureFile(
        join(context.root, "apps/cli/src/source.ts"),
        "source remains",
      );
      const mode = (await lstat(binary)).mode & 0o777;
      const packed = await packArtifact(context, "cli", target, downloads);
      await rm(dirname(binary), { recursive: true });
      await writeArtifactFixtureFile(join(dirname(binary), "stale-file"), "obsolete output");
      // Посторонний сломанный bundle не является prerequisite CLI и не должен читаться.
      await writeArtifactFixtureFile(
        join(downloads, `sdk-portable-${context.sha}`, "manifest.json"),
        "not JSON",
      );

      await restoreArtifacts(context, "cli", "test:process", target, downloads);

      expect(packed.name).toBe(`cli-${target}-${"a".repeat(40)}`);
      expect(await Bun.file(binary).text()).toBe("compiled cli\n");
      expect((await lstat(binary)).mode & 0o777).toBe(mode);
      expect(await readdir(dirname(binary))).toEqual([basename(binary)]);
      expect(await Bun.file(join(context.root, "apps/cli/src/source.ts")).text()).toBe(
        "source remains",
      );
    });
  });

  test("rest-sdk упаковывается как sdk-portable и восстанавливается на нативном consumer", async () => {
    await withArtifactFixture(async ({ context, downloads, target }) => {
      const generated = join(context.root, "packages/rest-sdk/dist/generated/client.js");
      await writeArtifactFixtureFile(generated, "export const sdk = true;");
      const packed = await packArtifact(context, "rest-sdk", "portable", downloads);
      await rm(dirname(generated), { recursive: true });

      await restoreArtifacts(context, "web", "build", target, downloads);

      expect(packed.name).toBe(`sdk-portable-${"a".repeat(40)}`);
      expect(await Bun.file(generated).text()).toBe("export const sdk = true;");
    });
  });

  test("отсутствие позднего prerequisite сохраняет ранее проверенные output без частичной замены", async () => {
    await withArtifactFixture(async ({ context, downloads, target, cliBinary }) => {
      const sdk = join(context.root, "packages/rest-sdk/dist/generated/client.js");
      const cli = join(context.root, cliBinary);
      await writeArtifactFixtureFile(sdk, "packed sdk");
      await writeArtifactFixtureFile(cli, "packed cli", 0o755);
      await packArtifact(context, "rest-sdk", "portable", downloads);
      await packArtifact(context, "cli", target, downloads);
      await writeFile(sdk, "current sdk");
      await writeFile(cli, "current cli");

      await expect(
        restoreArtifacts(context, "repository", "test:e2e:product", target, downloads),
      ).rejects.toMatchObject({ code: "ARTIFACT_MISSING" });

      expect(await Bun.file(sdk).text()).toBe("current sdk");
      expect(await Bun.file(cli).text()).toBe("current cli");
      expect(await Bun.file(join(context.root, "apps/server/dist/relay-server")).exists()).toBe(
        false,
      );
    });
  });

  test("чужой target metadata отклоняется без замены существующего output", async () => {
    await withArtifactFixture(async ({ context, downloads, target, cliBinary }) => {
      const binary = join(context.root, cliBinary);
      await writeArtifactFixtureFile(binary, "current output", 0o755);
      const packed = await packArtifact(context, "cli", target, downloads);
      const manifestPath = join(packed.path, "manifest.json");
      const manifest = await Bun.file(manifestPath).json();
      // Намеренно подменяем только metadata, оставляя исходное имя bundle и hash.
      await writeFile(manifestPath, JSON.stringify({ ...manifest, target: "wrong-target" }));

      await expect(
        restoreArtifacts(context, "cli", "test:process", target, downloads),
      ).rejects.toMatchObject({ code: "ARTIFACT_METADATA" });

      expect(await Bun.file(binary).text()).toBe("current output");
    });
  });

  test("повреждённые байты tar отклоняются по hash до распаковки", async () => {
    await withArtifactFixture(async ({ context, downloads, target, cliBinary }) => {
      const binary = join(context.root, cliBinary);
      await writeArtifactFixtureFile(binary, "current output", 0o755);
      const packed = await packArtifact(context, "cli", target, downloads);
      await appendFile(join(packed.path, "payload.tar"), "corruption");

      await expect(
        restoreArtifacts(context, "cli", "test:process", target, downloads),
      ).rejects.toMatchObject({ code: "ARTIFACT_HASH" });

      expect(await Bun.file(binary).text()).toBe("current output");
      expect(await readdir(downloads)).toEqual([packed.name]);
    });
  });

  test("корректный hash не разрешает архиву запись за пределами catalog directory", async () => {
    await withArtifactFixture(async ({ context, downloads, target, cliBinary }) => {
      const binary = join(context.root, cliBinary);
      const outside = join(context.root, "outside-output");
      await writeArtifactFixtureFile(binary, "current output", 0o755);
      await writeArtifactFixtureFile(outside, "preserved outside");
      const packed = await packArtifact(context, "cli", target, downloads);
      const archive = join(packed.path, "payload.tar");
      // Умышленно валидная metadata для недопустимого по структуре архива.
      await runArtifactTar([
        "--format=ustar",
        "-cf",
        archive,
        "-C",
        context.root,
        "apps/cli/dist",
        "outside-output",
      ]);
      const manifestPath = join(packed.path, "manifest.json");
      const manifest = await Bun.file(manifestPath).json();
      await writeFile(
        manifestPath,
        JSON.stringify({ ...manifest, sha256: await artifactDigest(archive) }),
      );

      await expect(
        restoreArtifacts(context, "cli", "test:process", target, downloads),
      ).rejects.toMatchObject({ code: "ARTIFACT_UNSAFE_ARCHIVE" });

      expect(await Bun.file(binary).text()).toBe("current output");
      expect(await Bun.file(outside).text()).toBe("preserved outside");
    });
  });

  test("pack не объявляет сборку текущего хоста бинарником другой ОС", async () => {
    await withArtifactFixture(async ({ context, downloads, target, cliBinary }) => {
      await writeArtifactFixtureFile(join(context.root, cliBinary), "compiled cli", 0o755);
      const other = targets.find((entry) => entry.id !== target);
      if (!other) {
        throw new Error("Для проверки нужны два поддержанных target");
      }

      await expect(packArtifact(context, "cli", other.id, downloads)).rejects.toMatchObject({
        code: "ARTIFACT_HOST",
      });

      expect(await Bun.file(join(context.root, cliBinary)).text()).toBe("compiled cli");
    });
  });
});
