import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readComponents, repository } from "./catalog";
import { verifyComponents, verifyWorkflowEntrypoints } from "./configuration";

const invalidLeafCommands = [
  {
    name: "вложенный script с флагом Bun runtime",
    task: "test:unit",
    command: "bun --bun run build && bun test .unit.test.ts",
  },
  {
    name: "прямая компиляция перед unit",
    task: "test:unit",
    command: "bun build ./src/index.ts --outdir ./dist && bun test .unit.test.ts",
  },
  {
    name: "фильтр отдельных unit-кейсов",
    task: "test:unit",
    command: "bun test .unit.test.ts -t один-сценарий",
  },
  {
    name: "прямая компиляция перед проверкой типов",
    task: "typecheck",
    command: "bun build --target=bun ./src/index.ts --outdir ./dist && bun --bun tsc --noEmit",
  },
];

const workflowChanges = [
  {
    name: "Types повторно запускает lint вместо typecheck",
    file: "quality.yml",
    before: "TASK: ${{ inputs.component == 'repository' && 'typecheck:repo' || 'typecheck' }}",
    after: "TASK: ${{ inputs.component == 'repository' && 'lint:repo' || 'lint' }}",
  },
  {
    name: "обычная проверка выключена условием шага",
    file: "task.yml",
    before: "        id: task\n",
    after: "        id: task\n        if: false\n",
  },
  {
    name: "ненулевой код проверки превращён в успешный job",
    file: "task.yml",
    before: "        id: task\n",
    after: "        id: task\n        continue-on-error: true\n",
  },
  {
    name: "матрица reusable job дублирует проверку одного target",
    file: "task.yml",
    before: "    runs-on: ${{ inputs.runner }}\n",
    after:
      "    runs-on: ${{ inputs.runner }}\n    strategy:\n      matrix:\n        repeat: [1, 2]\n",
  },
  {
    name: "ненулевой код подавляется на уровне всего job",
    file: "task.yml",
    before: "    runs-on: ${{ inputs.runner }}\n",
    after: "    runs-on: ${{ inputs.runner }}\n    continue-on-error: true\n",
  },
  {
    name: "Types больше не выполняется после отказа Lint",
    file: "quality.yml",
    before:
      "        if: ${{ !cancelled() && steps.setup.outcome == 'success' && steps.restore.outcome == 'success' }}\n",
    after: "",
  },
  {
    name: "команда использует фиксированный Linux target вместо входного",
    file: "task.yml",
    before: "          TASK: ${{ inputs.task }}\n          TARGET: ${{ inputs.target }}\n",
    after: "          TASK: ${{ inputs.task }}\n          TARGET: linux-x64\n",
  },
];

/**
 * Копирует только reusable workflows в отдельный каталог под .artifacts.
 * Callback меняет копии, не рабочее дерево; finally удаляет их также при падении проверки.
 */
async function withWorkflowCopies(run: (root: string) => Promise<void>): Promise<void> {
  const parent = join(repository, ".artifacts", new Date().toISOString().slice(0, 10), "ci-check");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "workflow-entrypoints-"));
  try {
    const directory = join(root, ".github/workflows");
    await mkdir(directory, { recursive: true });
    for (const name of ["task.yml", "quality.yml", "native-services.yml"]) {
      await copyFile(join(repository, ".github/workflows", name), join(directory, name));
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("Отклонение расхождений обязательного контура", () => {
  test.each(invalidLeafCommands)(
    "$name отклоняется как нарушение самостоятельной leaf-команды",
    async ({ task, command }) => {
      const component = (await readComponents()).find((entry) => entry.id === "core");
      if (!component) {
        throw new Error("Отсутствует Core");
      }
      const changed = {
        ...component,
        scripts: { ...component.scripts, [task]: command },
      };

      await expect(verifyComponents([changed])).rejects.toThrow("leaf-команда");
    },
  );

  test("новый обычный набор не остаётся вне локального и CI-каталога", async () => {
    const component = (await readComponents()).find((entry) => entry.id === "core");
    if (!component) {
      throw new Error("Отсутствует Core");
    }
    const changed = {
      ...component,
      scripts: { ...component.scripts, "test:smoke": "bun test ./tests/smoke" },
    };

    await expect(verifyComponents([changed])).rejects.toThrow("нужно включить в общий план");
  });

  test.each(workflowChanges)("$name: локальная сверка отклоняет workflow", async (change) => {
    await withWorkflowCopies(async (root) => {
      const path = join(root, ".github/workflows", change.file);
      const original = await readFile(path, "utf8");
      expect(original.split(change.before)).toHaveLength(2);
      await writeFile(path, original.replace(change.before, change.after));

      await expect(verifyWorkflowEntrypoints(root)).rejects.toThrow("leaf-команды");
    });
  });
});
