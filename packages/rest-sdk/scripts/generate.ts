import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { generateMessages } from "./generate.messages.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const input = join(root, "apps/server/openapi.json");
const output = join(root, "packages/rest-sdk/src/generated");
const arguments_ = process.argv.slice(2);

/**
 * Вызывает только публичный CLI закреплённого генератора; Bun здесь служит package runner.
 * Реализация CLI исполняется Node.js из PATH, второй lockfile в workspace не создаётся.
 */
function generate(directory: string): void {
  const result = spawnSync(
    "bun",
    ["x", "@gromlab/rest-api-codegen@5.2.4", "--input", input, "--output", directory],
    { cwd: root, stdio: "inherit" },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(generateMessages.generationFailed, { cause: result.error });
  }
}

/**
 * Читает точные байты всего output; дополнительные и удалённые файлы участвуют в сверке.
 */
async function generatedFiles(directory: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      files.set(relative(directory, path), await readFile(path));
    }
  }
  return files;
}

/**
 * Проверяет актуальность без перезаписи tracked output; временные файлы принадлежат artifacts.
 */
async function checkGenerated(): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const parent = join(root, ".artifacts", date, "server-web", "sdk-codegen");
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(join(parent, "check-"));
  try {
    const expectedPath = join(temporary, "generated");
    generate(expectedPath);
    const [expected, actual] = await Promise.all([
      generatedFiles(expectedPath),
      generatedFiles(output),
    ]);
    const names = new Set([...expected.keys(), ...actual.keys()]);
    const changed = [...names].filter((name) => {
      const expectedFile = expected.get(name);
      const actualFile = actual.get(name);
      return (
        expectedFile === undefined || actualFile === undefined || !expectedFile.equals(actualFile)
      );
    });
    if (changed.length > 0) {
      throw new Error(generateMessages.outdated(changed.sort()));
    }
    console.log(generateMessages.current);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (Number(process.versions.node.split(".")[0]) < 24 || "bun" in process.versions) {
  throw new Error(generateMessages.nodeRequired);
}
if (arguments_.length > 1 || (arguments_.length === 1 && arguments_[0] !== "--check")) {
  throw new Error(generateMessages.invalidArguments);
}
if (arguments_[0] === "--check") {
  await checkGenerated();
} else {
  await mkdir(dirname(output), { recursive: true });
  generate(output);
}
