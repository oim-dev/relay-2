import { describe, expect, spyOn, test } from "bun:test";
import { BATCH_OPERATIONS } from "@relay/core";
import { getBatchFieldContract, getBatchOperationContract } from "./help-contract";
import * as fields from "./help-contract-fields";
import { historyHelpContractFactories } from "./help-contract-history";
import { knowledgeHelpContractFactories } from "./help-contract-knowledge";
import { planningHelpContractFactories } from "./help-contract-planning";
import { taskHelpContractFactories } from "./help-contract-tasks";

const selectedLeaves = [
  { op: "document.create", field: "sectionId", textField: "name", text: "Правила поиска" },
  { op: "task.create", field: "parent", textField: "title", text: "Сохранить запрос при ошибке" },
  { op: "plan.stage.create", field: "before", textField: "title", text: "Реализация и проверка" },
  {
    op: "session.start",
    field: "operator",
    textField: "title",
    text: "Проверить восстановление поиска",
  },
] as const;
const policyFactories = [
  "requiredField",
  "defaultField",
  "nullableField",
  "optionalField",
  "aliasField",
  "updateField",
] as const;

describe("Избирательная подготовка контрактов batch", () => {
  test.each(selectedLeaves)(
    "регистрация не готовит подробности, запрос $op создаёт только свой лист",
    ({ op, field, textField, text }) => {
      const definitions = spyOn(fields, "defineContract");
      const policies = policyFactories.map((name) => spyOn(fields, name));
      try {
        // Тот же путь регистрации, что при импорте фасада. Независимый реестр исключает
        // зависимость от уже заполненного кеша API и порядка остальных тестовых файлов.
        const factories = new Map([
          ...knowledgeHelpContractFactories(),
          ...taskHelpContractFactories(),
          ...planningHelpContractFactories(),
          ...historyHelpContractFactories(),
        ]);
        expect([...factories.keys()].sort()).toEqual(
          BATCH_OPERATIONS.map((item) => item.op).sort(),
        );
        expect(definitions).not.toHaveBeenCalled();
        for (const policy of policies) {
          expect(policy).not.toHaveBeenCalled();
        }
        const create = factories.get(op);
        if (!create) {
          throw new Error(`Не зарегистрирована фабрика ${op}`);
        }

        const selected = create();

        expect(definitions.mock.calls.map(([operation]) => operation)).toEqual([op]);
        expect(policies.some((policy) => policy.mock.calls.length > 0)).toBe(true);
        expect(selected.example.op).toBe(op);
        expect(selected.example.input?.[textField]).toBe(text);
        expect(selected.fields[field]?.nullable).toBe(true);
      } finally {
        definitions.mockRestore();
        for (const policy of policies) {
          policy.mockRestore();
        }
      }
    },
  );

  test("повторный запрос использует неизменяемый контракт статической версии кода", () => {
    const first = getBatchOperationContract("document.create");
    const firstField = getBatchFieldContract("document.create", "sectionId");

    const second = getBatchOperationContract("document.create");
    const secondField = getBatchFieldContract("document.create", "sectionId");

    expect(second.example).toBe(first.example);
    expect(second.rules).toBe(first.rules);
    expect(secondField).toBe(firstField);
    expect(Object.isFrozen(firstField)).toBe(true);
    expect(Object.isFrozen(first.rules)).toBe(true);
    expect(Object.isFrozen(first.example)).toBe(true);
    expect(Object.isFrozen(first.example.input)).toBe(true);
    const relations = first.example.input?.relations;
    expect(Object.isFrozen(relations)).toBe(true);
    if (!Array.isArray(relations)) {
      throw new Error("В примере документа ожидается массив прикреплений");
    }
    expect(Object.isFrozen(relations[0])).toBe(true);
    expect(Object.isFrozen(relations[0]?.target)).toBe(true);
  });
});
