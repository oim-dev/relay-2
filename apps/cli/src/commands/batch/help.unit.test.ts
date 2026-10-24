import { describe, expect, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { BATCH_OPERATIONS } from "@relay/core";
import { ProjectDatabase } from "@relay/storage";
import type { BatchOperationDescription } from "@relay/contracts";
import type { Args } from "gunshi";
import { createProgram } from "../../app/program";
import type { RegistryCommand } from "../../execution/registry.types";
import { helpRuntime, invokeIsolatedCli } from "../../../tests/helpers/help";
import { describeBatchOperation } from "./help";
import type { BatchFieldHelp, BatchOperationHelp } from "./help.types";

const aliases = [
  { op: "scenario.create", field: "featureId", format: 'string | {"$ref":string}', text: "фичи" },
  {
    op: "implementation.create",
    field: "applicationId",
    format: 'string | {"$ref":string}',
    text: "приложение",
  },
  { op: "release.create", field: "planIds", format: '(string | {"$ref":string})[]', text: "плана" },
  { op: "release.create", field: "version", format: "string", text: "выпуска" },
  { op: "plan.stage.update", field: "stageId", format: 'string | {"$ref":string}', text: "этапа" },
  {
    op: "plan.stage.task.transfer",
    field: "targetStage",
    format: 'string | {"$ref":string}',
    text: "этапа",
  },
  {
    op: "task.criterion.update",
    field: "id",
    format: 'string | {"$ref":string}',
    text: "критерия",
  },
  {
    op: "task.criterion.update",
    field: "criterionId",
    format: 'string | {"$ref":string}',
    text: "критерия",
  },
  { op: "session.pause", field: "runId", format: "string", text: "currentRunId" },
  {
    op: "checkpoint.save",
    field: "acceptedSessionIds",
    format: '(string | {"$ref":string})[]',
    text: "Ссылки на принимаемые завершённые (completed) прямые дочерние сессии",
  },
  {
    op: "document.link",
    field: "type",
    format: 'enum ("documents" | "references")',
    text: "связи",
  },
] as const;

/**
 * Находит обязательную запись каталога; ошибочная подготовка не превращается в пустую проверку.
 */
function operation(op: string): BatchOperationDescription {
  const found = BATCH_OPERATIONS.find((entry) => entry.op === op);
  assert(found, `В каталоге отсутствует ${op}`);
  return found;
}

/**
 * Находит команду в свежем дереве для проверки зависимости от живых метаданных владельца.
 */
function command(commands: ReadonlyMap<string, RegistryCommand>, op: string): RegistryCommand {
  let found: RegistryCommand | undefined;
  for (const part of op.split(".")) {
    found = commands.get(part);
    assert(found, `Команда ${op} не зарегистрирована`);
    commands = found.subCommands;
  }
  assert(found);
  return found;
}

/**
 * Возвращает canonical поле из готовой справочной проекции.
 */
function field(metadata: readonly BatchOperationHelp[], op: string, name: string): BatchFieldHelp {
  const found = metadata
    .find((entry) => entry.operation.op === op)
    ?.fields.find((entry) => entry.name === name);
  assert(found, `В справке отсутствует ${op}.input.${name}`);
  return found;
}

/**
 * Открывает настоящую подробную справку одной операции по пути из отдельных слов.
 */
async function operationHelp(op: string): Promise<string> {
  const response = await invokeIsolatedCli(["batch", "help", ...op.split("."), "-h"]);
  expect(response).toMatchObject({ exitCode: 0, stderr: "" });
  return response.stdout;
}

/**
 * Создаёт свежие метаданные одного действия с намеренно изменённой схемой поля.
 */
function withArguments(op: string, args: Args): readonly BatchOperationHelp[] {
  const commands = createProgram(helpRuntime).options.subCommands;
  command(commands, op).args = args;
  return [describeBatchOperation(operation(op), commands)];
}

describe("Метаданные полей атомарного пакета", () => {
  test("каждое поле полного каталога имеет формат и назначение, состав Core сохраняется", () => {
    const commands = createProgram(helpRuntime).options.subCommands;

    const metadata = BATCH_OPERATIONS.map((operation) =>
      describeBatchOperation(operation, commands),
    );

    expect(metadata.map((entry) => entry.operation)).toEqual([...BATCH_OPERATIONS]);
    expect(metadata).toHaveLength(72);
    for (const entry of metadata) {
      expect(entry.fields.map((value) => value.name)).toEqual([...entry.operation.inputFields]);
      for (const value of entry.fields) {
        expect(
          value.description.trim().length,
          `${entry.operation.op}.${value.name}`,
        ).toBeGreaterThan(0);
        expect(value.format.length, `${entry.operation.op}.${value.name}`).toBeGreaterThan(0);
        expect(value.description).not.toContain("повторяйте параметр");
        expect(value.contract.presence.trim().length).toBeGreaterThan(0);
        expect(value.contract.omission.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test("прямые описания и enum берутся из живой схемы без исполнения parser или required/default", () => {
    const commands = createProgram(helpRuntime).options.subCommands;
    const product = command(commands, "product.create");
    assert(product.args?.description);
    product.args.description = {
      type: "string",
      description: "Новое назначение Markdown владельца",
      required: true,
      default: "Не обещать в batch",
    };
    const application = command(commands, "application.create");
    assert(application.args?.type);
    application.args.type = {
      type: "enum",
      description: "Живое перечисление",
      choices: ["special"],
    };

    const metadata = [operation("product.create"), operation("application.create")].map(
      (operation) => describeBatchOperation(operation, commands),
    );

    expect(field(metadata, "product.create", "description")).toMatchObject({
      name: "description",
      format: "string",
      description: "Новое назначение Markdown владельца",
      contract: {
        presence: "Необязательно.",
        omission: 'При пропуске используется "".',
        nullable: false,
      },
    });
    expect(field(metadata, "application.create", "type")).toMatchObject({
      name: "type",
      format: 'enum ("special")',
      description: "Живое перечисление",
    });
  });

  test.each(aliases)(
    "$op.$field использует предметное имя и правильный CLI-источник",
    ({ op, field: name, format, text }) => {
      const commands = createProgram(helpRuntime).options.subCommands;

      const metadata = [describeBatchOperation(operation(op), commands)];

      const value = field(metadata, op, name);
      expect(value.name).toBe(name);
      expect(value.format).toBe(format);
      expect(value.description).toContain(text);
    },
  );

  test("scope, целевые предусловия и operator сохраняют формы batch", () => {
    const commands = createProgram(helpRuntime).options.subCommands;

    const metadata = BATCH_OPERATIONS.map((operation) =>
      describeBatchOperation(operation, commands),
    );

    const scope = field(metadata, "plan.create", "scope");
    expect(scope.format).toBe("JSON-массив {kind, id}");
    expect(scope.description).toContain('[{"kind":"feature","id":"FEATURE-1"}]');
    expect(scope.description).toContain('id — адрес записи или {"$ref":"имя"}');
    const revision = field(metadata, "plan.stage.task.transfer", "targetRevision");
    expect(revision.format).toBe('number | {"$revision":string}');
    expect(revision.description).toContain("положительное целое число");
    expect(revision.description).toContain("целевому плану");
    const targetVersion = field(metadata, "plan.stage.task.transfer", "targetVersion");
    expect(targetVersion.format).toBe("string");
    expect(targetVersion.description).toContain("aggregateVersion целевого плана targetPlan");
    expect(targetVersion.description).toContain("альтернативно targetRevision или вместе с ним");
    expect(command(commands, "plan.stage.task.transfer").args?.["target-version"]).toBeDefined();
    const operator = field(metadata, "session.start", "operator");
    expect(operator.format).toBe("JSON-объект | null");
    expect(operator.description).toContain("name?:string|null,email?:string|null,source:string");
    expect(operator.description).toContain("explicit | environment | git | inherited");
    expect(field(metadata, "plan.stage.move", "direction").format).toBe('enum ("up" | "down")');
    expect(field(metadata, "plan.stage.move", "before").contract.nullable).toBe(true);
    expect(field(metadata, "plan.stage.move", "before").contract.nullMeaning).toContain("конец");
    expect(field(metadata, "plan.stage.move", "before").description).not.toContain("без параметра");
  });

  test("неизвестное поле не получает вымышленное описание", () => {
    const commands = createProgram(helpRuntime).options.subCommands;

    expect(() =>
      describeBatchOperation(
        { ...operation("product.create"), inputFields: ["missingField"] },
        commands,
      ),
    ).toThrow("product.create.input.missingField");
  });

  test("операция без зарегистрированной команды отклоняется с её именем", () => {
    const commands = createProgram(helpRuntime).options.subCommands;

    expect(() =>
      describeBatchOperation({ ...operation("product.create"), op: "missing.create" }, commands),
    ).toThrow("не зарегистрирована команда missing.create");
  });

  test("пустое назначение поля отклоняется с точным путём", () => {
    expect(() =>
      withArguments("product.create", { name: { type: "string", description: " " } }),
    ).toThrow("product.create.input.name");
  });

  test("неизвестный custom parser не объявляется JSON и не запускается", () => {
    let parses = 0;

    expect(() =>
      withArguments("product.create", {
        name: {
          type: "custom",
          description: "Неизвестное преобразование",
          /**
           * Считает ошибочное выполнение parser при формировании метаданных.
           */
          parse: (value: string): string => {
            parses++;
            return value;
          },
        },
      }),
    ).toThrow("не определён формат поля product.create.input.name");

    expect(parses).toBe(0);
  });

  test("enum без допустимых значений отклоняется вместо неполной справки", () => {
    expect(() =>
      withArguments("application.create", {
        ...command(createProgram(helpRuntime).options.subCommands, "application.create").args,
        type: { type: "enum", description: "Неполное перечисление" },
      }),
    ).toThrow("отсутствуют значения enum поля application.create.input.type");
  });
});

describe("Самодостаточная справка одной операции batch", () => {
  test.each(["save", "complete", "cancel"])(
    "checkpoint.%s описывает acceptedSessionIds как ссылки на завершённых прямых детей",
    async (action) => {
      const help = await operationHelp(`checkpoint.${action}`);

      expect(help).toContain(
        'acceptedSessionIds: (string | {"$ref":string})[] — Ссылки на принимаемые завершённые (completed) прямые дочерние сессии исходного намерения',
      );
      expect(help).toContain("ID, ключи, алиасы или типизированные ссылки");
      expect(help).toContain('JSON-массив строковых ссылок или {"$ref":"имя"}');
      expect(help).toContain("acceptedSessionIds.*");
      expect(help).not.toContain("Только постоянный ID завершённого");
      expect(help).not.toContain("ключ не принимается");
    },
  );

  test("реальный runCli показывает Markdown, типы, enum и ссылки без проекта и чтения stdin", async () => {
    const open = spyOn(ProjectDatabase, "open");
    try {
      const product = await operationHelp("product.create");
      expect(product).toContain(
        "    name: string — Непустое однострочное название записи обычным текстом",
      );
      expect(product).toContain(
        "    summary: string — Краткая текстовая аннотация для списков; не заменяет полное содержание",
      );
      expect(product).toContain(
        "    description: string — Полный Markdown паспорта: назначение, аудитория, границы и результат",
      );
      expect(product).toContain(
        'ifRevision: positive integer | {"$revision":string} — обязательно',
      );
      expect(product).toContain("владелец: product");
      expect(product).toContain(
        "expectedVersion: string — обязательно, если ifRevision не передан",
      );
      expect(product).toContain("versions.aggregateVersion");
      expect(product).toContain("readVersionedEntity(db.commands, ref, kind?)");
      const document = await operationHelp("document.create");
      expect(document).toContain('documentStatus: enum ("draft" | "active" | "archived")');
      expect(document).toContain("pinned: boolean —");
      expect(await operationHelp("task.create")).toContain("acceptanceCriteria: JSON —");
      const plan = await operationHelp("plan.create");
      expect(plan).toContain("scope: JSON-массив {kind, id}");
      expect(plan).toContain("Поля input с поддержкой $ref: scope.*.id");
      expect(await operationHelp("plan.stage.task.add")).toContain(
        'stageId: string | {"$ref":string}',
      );
      expect(await operationHelp("task.parent.clear")).toContain(
        "input: {} — пустой объект, полей нет",
      );
      const transfer = await operationHelp("plan.stage.task.transfer");
      expect(transfer).toContain('targetRevision: number | {"$revision":string}');
      expect(transfer).toContain("targetVersion: string");
      expect(product).not.toContain("повторяйте параметр");
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  });

  test("общая batch help объясняет переносимый токен и обе формы предусловия предметной команды", async () => {
    const batch = await invokeIsolatedCli(["batch", "--help"]);
    const subject = await invokeIsolatedCli(["document", "update", "--help"]);

    expect(batch).toMatchObject({ exitCode: 0, stderr: "" });
    expect(batch.stdout).toContain("передайте ifRevision либо expectedVersion");
    expect(batch.stdout).toContain("можно передать оба, тогда проверяются оба");
    expect(batch.stdout).toContain("versions.aggregateVersion");
    expect(batch.stdout).toContain("CommandExecutor.readVersioned");
    expect(subject).toMatchObject({ exitCode: 0, stderr: "" });
    expect(subject.stdout).toContain("--if-revision");
    expect(subject.stdout).toContain("--expected-version");
  });
});
