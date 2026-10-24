import { describe, expect, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { BATCH_OPERATIONS } from "@relay/core";
import { ProjectDatabase } from "@relay/storage";
import { createProgram } from "../../app/program";
import { completionCandidates } from "../../app/completion-candidates";
import {
  commandRoutes,
  helpRuntime,
  invokeIsolatedCli as invoke,
} from "../../../tests/helpers/help";
import { findBatchSubjectCommand } from "./help";
import * as contracts from "./help-contract";

const sections = [
  "application",
  "board",
  "checkpoint",
  "document",
  "feature",
  "implementation",
  "plan",
  "product",
  "project",
  "release",
  "scenario",
  "session",
  "task",
];
const routes = commandRoutes(createProgram(helpRuntime).options.subCommands).filter(
  (route) => route.name === "batch help" || route.name.startsWith("batch help "),
);
const invalidPaths = [
  { name: "dotted-имя", argv: ["batch", "help", "plan.stage.create"] },
  { name: "отсутствующее действие batch", argv: ["batch", "help", "plan", "list"] },
  { name: "неизвестный раздел", argv: ["batch", "help", "unknown"] },
  {
    name: "попытка выполнить лист через input",
    argv: ["batch", "help", "plan", "create", "--input", "-"],
  },
] as const;
const envelopeContracts = [
  { op: "plan.stage.create", ref: true, owner: "work-plan" },
  { op: "product.create", ref: false, owner: "product" },
  { op: "feature.create", ref: false, owner: null },
  { op: "task.comment.add", ref: true, owner: null },
  { op: "checkpoint.complete", ref: true, owner: "work-session" },
] as const;

/**
 * Читает только имена видимых подкоманд из отдельной секции навигации.
 */
function listedCommands(text: string): string[] {
  const section = text.split("КОМАНДЫ:\n")[1]?.split("\n\n")[0];
  assert(section, "Ожидался список подкоманд справки");
  return section.split("\n").map((line) => line.trim().split(/\s+/)[0] ?? "");
}

/**
 * Декодирует JSON из единственного shell-примера, сохраняя экранированные апострофы.
 */
function examplePackage(text: string): unknown {
  const value = text.match(/--input '([\s\S]*)'\s*$/)?.[1];
  assert(value, "Ожидался JSON-пример пакета");
  return JSON.parse(value.replaceAll("'\\''", "'"));
}

describe("Навигация по справке batch", () => {
  test.each(envelopeContracts)(
    "$op явно описывает обязательные и запрещённые поля оболочки",
    async ({ op, ref, owner }) => {
      const response = await invoke(["batch", "help", ...op.split(".")]);

      expect(response).toMatchObject({ exitCode: 0, stderr: "" });
      expect(response.stdout).toContain(
        ref ? '  ref: string | {"$ref":string} — обязательно.' : "  ref: не принимается",
      );
      expect(response.stdout).toContain(
        owner === null
          ? "  ifRevision: не принимается"
          : `  ifRevision: positive integer | {"$revision":string} — обязательно, если expectedVersion не передан; владелец: ${owner}`,
      );
      expect(response.stdout).toContain(
        owner === null
          ? "  expectedVersion: не принимается"
          : `  expectedVersion: string — обязательно, если ifRevision не передан; владелец: ${owner}`,
      );
      if (owner !== null) {
        expect(response.stdout).toContain("Если переданы оба предусловия, проверяются оба");
        expect(response.stdout).toContain("versions.aggregateVersion");
        expect(response.stdout).toContain("versioned read владельца");
      }
      expect(response.stdout).not.toContain("ifRevision: не требуется");
    },
  );

  test("дерево содержит 13 разделов и отдельный справочный лист каждой операции каталога", () => {
    const commands = createProgram(helpRuntime).options.subCommands;
    const root = findBatchSubjectCommand(commands, "batch.help");

    expect([...root.subCommands.keys()].sort()).toEqual(sections);
    expect(routes.filter((route) => !route.hasSubcommands)).toHaveLength(BATCH_OPERATIONS.length);
    for (const operation of BATCH_OPERATIONS) {
      const leaf = findBatchSubjectCommand(commands, `batch.help.${operation.op}`);
      const subject = findBatchSubjectCommand(commands, operation.op);
      expect(leaf.description).toBe(subject.description);
      expect(leaf.args).toBeUndefined();
      expect(leaf.subCommands.size).toBe(0);
      expect(
        routes.find((route) => route.name === `batch help ${operation.op.replaceAll(".", " ")}`)
          ?.group,
      ).toBe(true);
    }
  });

  test.each(routes)(
    "$name: bare и -h совпадают без проекта, stdin и автора даже с format=json",
    async ({ argv }) => {
      const bare = await invoke([...argv, "--format=json"]);
      const help = await invoke([...argv, "-h"]);

      expect(bare).toEqual(help);
      expect(bare).toMatchObject({ exitCode: 0, stderr: "" });
      expect(bare.stdout).toContain(`ИСПОЛЬЗОВАНИЕ:\n  relay ${argv.join(" ")}`);
      expect(bare.stdout.startsWith("{")).toBe(false);
    },
  );

  test("root и plan/stage перечисляют только ближайшие разделы с конкретными назначениями", async () => {
    const root = await invoke(["batch", "help"]);
    const plan = await invoke(["batch", "help", "plan"]);
    const stages = await invoke(["batch", "help", "plan", "stage"]);

    expect(listedCommands(root.stdout)).toEqual(sections);
    expect(listedCommands(plan.stdout)).toEqual([
      "cancel",
      "complete",
      "create",
      "stage",
      "start",
      "update",
    ]);
    expect(listedCommands(stages.stdout)).toEqual(["create", "move", "remove", "task", "update"]);
    expect(plan.stdout).toContain("Создать черновик плана");
    expect(plan.stdout).toContain("Этапы плана и их порядок");
    expect(stages.stdout).toContain("Создать этап открытого плана");
    for (const response of [root, plan, stages]) {
      expect(response).toMatchObject({ exitCode: 0, stderr: "" });
      expect(response.stdout).not.toContain("  input:");
      expect(response.stdout).not.toContain("Наличие:");
      expect(response.stdout).not.toContain("JSON-массив {kind, id}");
    }
    expect(plan.stdout).not.toContain("Создать задачу");
    expect(stages.stdout).not.toContain("release");
  });

  test("лист этапа показывает только его поля, policy, Markdown и автономный пакет с правильным op/CAS", async () => {
    const response = await invoke(["batch", "help", "plan", "stage", "create"]);
    const expected = contracts.getBatchOperationContract("plan.stage.create");
    const before = contracts.getBatchFieldContract("plan.stage.create", "before");

    expect(response).toMatchObject({ exitCode: 0, stderr: "" });
    expect(response.stdout.startsWith("Создать этап открытого плана\n\n")).toBe(true);
    expect(response.stdout).toContain("Операция: plan.stage.create");
    expect(response.stdout).toContain("outcome: string — Ожидаемый результат этапа в Markdown");
    expect(response.stdout).toContain(
      "completionConditions: string — Условия проверки и завершения этапа в Markdown",
    );
    expect(response.stdout).toContain('before: string | {"$ref":string} | null');
    expect(response.stdout).toContain(`Наличие: ${before.presence}`);
    expect(response.stdout).toContain(`\n      ${before.omission}\n`);
    expect(response.stdout).toContain(`null: ${before.nullMeaning}`);
    expect(response.stdout.match(/^      null:/gm)).toHaveLength(1);
    expect(response.stdout).toContain("владелец: work-plan");
    expect(response.stdout).toContain("Поля input с поддержкой $ref: before");
    expect(response.stdout).not.toContain("Операция: plan.stage.update");
    expect(response.stdout).not.toContain("documentStatus:");
    expect(examplePackage(response.stdout)).toEqual({ version: 1, operations: [expected.example] });
    expect(expected.example).toMatchObject({
      op: "plan.stage.create",
      ref: "PLN-1",
      ifRevision: 1,
    });
    expect(JSON.stringify(expected.example)).not.toContain('"$ref"');
    expect(JSON.stringify(expected.example)).not.toContain('"$revision"');
  });

  test("createProgram, root/version/get и completion не запрашивают поля, лист получает только собственный контракт", async () => {
    const fields = spyOn(contracts, "getBatchFieldContract");
    const operations = spyOn(contracts, "getBatchOperationContract");
    const open = spyOn(ProjectDatabase, "open");
    try {
      const program = createProgram(helpRuntime);
      for (const argv of [
        ["--version"],
        ["batch", "-h"],
        ["batch", "help"],
        ["batch", "help", "plan", "stage"],
        ["batch", "help", "plan", "stage", "create", "--version"],
      ]) {
        expect((await invoke(argv)).exitCode).toBe(0);
      }
      const get = await invoke(["get", "PROJECT", "--format=json"]);
      expect(get.exitCode).toBe(3);
      expect(JSON.parse(get.stderr)).toMatchObject({ error: { code: "CONFIG_NOT_FOUND" } });
      const completion = completionCandidates(program.options.subCommands, {
        format: { type: "enum", choices: ["text", "json"] },
      });
      expect(
        completion.subCommands?.["batch help plan stage create"]?.args?.format?.handler({}),
      ).toEqual([{ value: "text" }, { value: "json" }]);
      expect(completion.subCommands?.["batch help plan stage create"]?.args?.title).toBeUndefined();
      expect(fields).not.toHaveBeenCalled();
      expect(operations).not.toHaveBeenCalled();

      const leaf = await invoke(["batch", "help", "plan", "stage", "create", "-h"]);

      expect(leaf.exitCode).toBe(0);
      expect(fields.mock.calls).toEqual(
        ["title", "summary", "outcome", "completionConditions", "before"].map((field) => [
          "plan.stage.create",
          field,
        ]),
      );
      expect(operations.mock.calls).toEqual([["plan.stage.create"]]);
      expect(open).not.toHaveBeenCalled();
    } finally {
      fields.mockRestore();
      operations.mockRestore();
      open.mockRestore();
    }
  });

  test.each(invalidPaths)("$name отклоняется без исполнения batch", async ({ argv }) => {
    const response = await invoke([...argv, "--format=json"]);

    expect(response.exitCode).toBe(2);
    expect(response.stdout).toBe("");
    expect(JSON.parse(response.stderr)).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
  });
});
