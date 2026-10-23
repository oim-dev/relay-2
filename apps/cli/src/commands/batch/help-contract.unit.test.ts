import { describe, expect, test } from "bun:test";
import { BATCH_OPERATIONS } from "@relay/core";
import { DOCUMENT_RELATION_TYPES, historyOperatorSources } from "@relay/contracts";
import { getBatchFieldContract, getBatchOperationContract } from "./help-contract";

const requiredFields = new Set([
  ...[
    "project",
    "product",
    "feature",
    "scenario",
    "application",
    "implementation",
    "document",
    "board",
  ].map((kind) => `${kind}.rename.key`),
  ...["product", "feature", "scenario", "application", "document"].map(
    (kind) => `${kind}.create.name`,
  ),
  "application.create.slug",
  "implementation.create.title",
  "implementation.create.target",
  "document.create.body",
  "application.participation.replace.targets",
  "document.link.target",
  "document.unlink.target",
  "document.section.create.name",
  "document.section.update.id",
  "document.section.update.name",
  "document.section.move.id",
  "document.section.remove.id",
  "task.parent.set.parent",
  "task.dependency.add.target",
  "task.dependency.remove.target",
  "task.link.target",
  "task.unlink.target",
  "task.criterion.add.title",
  "task.comment.add.body",
  "plan.create.title",
  "plan.complete.result",
  "plan.cancel.result",
  "release.create.title",
  "release.create.version",
  "release.create.planIds",
  "plan.stage.create.title",
  "plan.stage.update.stageId",
  "plan.stage.move.stageId",
  "plan.stage.remove.stageId",
  "plan.stage.task.add.stageId",
  "plan.stage.task.add.task",
  "plan.stage.task.remove.stageId",
  "plan.stage.task.remove.task",
  ...["task", "targetPlan", "targetStage", "reason", "targetRevision"].map(
    (field) => `plan.stage.task.transfer.${field}`,
  ),
  "session.start.title",
  "session.fork.title",
  "session.fork.runId",
  "session.takeover.reason",
  "session.pause.runId",
  "session.pause.reason",
  "session.complete.runId",
  "session.complete.result",
  "session.cancel.result",
  ...["open", "save", "complete", "cancel"].flatMap((action) =>
    ["title", "body", "runId"].map((field) => `checkpoint.${action}.${field}`),
  ),
]);
const nullableFields = new Set([
  "document.create.sectionId",
  "document.update.sectionId",
  "task.create.parent",
  "document.section.move.before",
  "plan.stage.create.before",
  "plan.stage.move.before",
  "session.start.operator",
  "session.attach.operator",
  "session.resume.operator",
  "session.takeover.operator",
]);
const defaults = [
  { op: "application.create", field: "type", value: "frontend" },
  { op: "implementation.create", field: "status", value: "none" },
  { op: "document.create", field: "documentKind", value: "description" },
  { op: "document.create", field: "documentStatus", value: "draft" },
  { op: "document.create", field: "pinned", value: false },
  { op: "task.create", field: "board", value: "BOARD-PRODUCT" },
  { op: "task.create", field: "column", value: "inbox" },
  ...["product", "feature", "scenario", "application"].flatMap((kind) =>
    ["summary", "description"].map((field) => ({ op: `${kind}.create`, field, value: "" })),
  ),
  { op: "implementation.create", field: "description", value: "" },
  { op: "document.create", field: "summary", value: "" },
  ...["title", "description"].map((field) => ({ op: "task.create", field, value: "" })),
  ...["dependencies", "related", "targets", "acceptanceCriteria"].map((field) => ({
    op: "task.create",
    field,
    value: [],
  })),
  ...["summary", "description"].map((field) => ({ op: "task.criterion.add", field, value: "" })),
  { op: "task.comment.add", field: "title", value: "" },
  ...["summary", "goal", "rationale", "boundaries", "expectedResult"].map((field) => ({
    op: "plan.create",
    field,
    value: "",
  })),
  ...["scope", "participants"].map((field) => ({ op: "plan.create", field, value: [] })),
  ...["summary", "description"].map((field) => ({ op: "release.create", field, value: "" })),
  ...["summary", "outcome", "completionConditions"].map((field) => ({
    op: "plan.stage.create",
    field,
    value: "",
  })),
  ...["open", "save", "complete", "cancel"].map((action) => ({
    op: `checkpoint.${action}`,
    field: "references",
    value: [],
  })),
  ...["save", "complete", "cancel"].map((action) => ({
    op: `checkpoint.${action}`,
    field: "acceptedSessionIds",
    value: [],
  })),
];
const aliases = [
  { op: "scenario.create", left: "feature", right: "featureId" },
  { op: "implementation.create", left: "application", right: "applicationId" },
  ...["update", "complete", "reopen", "remove"].map((action) => ({
    op: `task.criterion.${action}`,
    left: "id",
    right: "criterionId",
  })),
  { op: "plan.stage.move", left: "before", right: "direction" },
] as const;
const preservedTaskFields = [
  { op: "task.update", field: "targets" },
  { op: "task.move", field: "board" },
  { op: "task.move", field: "column" },
] as const;

describe("Предметные политики всех полей batch", () => {
  test("каталог содержит 72 листа без пропущенных политик и выдуманного null", () => {
    expect(BATCH_OPERATIONS).toHaveLength(72);
    const seenRequired = new Set<string>();
    const seenNullable = new Set<string>();
    for (const operation of BATCH_OPERATIONS) {
      for (const field of operation.inputFields) {
        const path = `${operation.op}.${field}`;
        const contract = getBatchFieldContract(operation.op, field);
        expect(contract.presence === "Обязательно.").toBe(requiredFields.has(path));
        expect(contract.nullable).toBe(nullableFields.has(path));
        if (requiredFields.has(path)) {
          seenRequired.add(path);
          expect(contract.omission).toBe("Пропуск приводит к ошибке: значение не подставляется.");
        }
        if (contract.nullable) {
          seenNullable.add(path);
          expect(contract.nullMeaning).toEqual(expect.any(String));
        } else {
          expect(contract.nullMeaning).toBeUndefined();
        }
      }
    }
    expect(seenRequired).toEqual(requiredFields);
    expect(seenNullable).toEqual(nullableFields);
  });

  test.each(defaults)(
    "$op.input.$field документирует фактическое начальное значение",
    ({ op, field, value }) => {
      expect(getBatchFieldContract(op, field)).toEqual({
        presence: "Необязательно.",
        omission: `При пропуске используется ${JSON.stringify(value)}.`,
        nullable: false,
      });
    },
  );

  test.each(aliases)(
    "$op: $left и $right обязательны как взаимоисключающая альтернатива",
    ({ op, left, right }) => {
      for (const [field, alternative] of [
        [left, right],
        [right, left],
      ] as const) {
        const policy = getBatchFieldContract(op, field);
        expect(policy.presence).toBe(
          `Обязательно одно из двух полей; альтернатива — ${alternative}. Одновременно оба запрещены.`,
        );
        expect(policy.omission).toBe(
          `При пропуске требуется ${alternative}; без обоих полей операция отклоняется.`,
        );
      }
      const input = getBatchOperationContract(op).example.input ?? {};
      expect(Number(Object.hasOwn(input, left)) + Number(Object.hasOwn(input, right))).toBe(1);
    },
  );

  test("частичная правка сохраняет пропущенные поля и требует непустого изменения", () => {
    for (const operation of BATCH_OPERATIONS.filter(
      (item) => item.op.endsWith(".update") && item.op !== "document.section.update",
    )) {
      for (const field of operation.inputFields.filter(
        (field) =>
          !["id", "criterionId", "stageId", "targets", "relations", "plannedFor"].includes(field),
      )) {
        expect(getBatchFieldContract(operation.op, field)).toEqual({
          presence: "Необязательно отдельно; передайте хотя бы одно изменяемое поле операции.",
          omission: "Пропуск сохраняет текущее значение.",
          nullable: false,
          ...(field === "sectionId"
            ? { nullable: true, nullMeaning: "Снять документ с раздела." }
            : {}),
        });
      }
    }
    expect(getBatchOperationContract("task.move").rules.join(" ")).toContain(
      "хотя бы board или column",
    );
    expect(getBatchOperationContract("task.criterion.update").rules.join(" ")).toContain(
      "хотя бы одно из title, summary, description",
    );
  });

  test.each(preservedTaskFields)(
    "$op.input.$field: пропуск сохраняет прежнее значение без defaults создания",
    ({ op, field }) => {
      const policy = getBatchFieldContract(op, field);

      expect(policy).toEqual({
        presence: "Необязательно отдельно; передайте хотя бы одно изменяемое поле операции.",
        omission: "Пропуск сохраняет текущее значение.",
        nullable: false,
      });
    },
  );

  test("разделы и этапы различают генерацию ID, пропуск позиции и явный конец", () => {
    expect(getBatchFieldContract("document.section.create", "id").omission).toContain(
      "генерирует новый UUID",
    );
    expect(getBatchFieldContract("document.section.update", "id").presence).toBe("Обязательно.");
    expect(getBatchFieldContract("document.section.move", "before")).toMatchObject({
      nullable: true,
      nullMeaning: "Поместить в конец списка.",
    });
    expect(getBatchFieldContract("document.section.move", "last").presence).toContain(
      "false допустим только вместе с before",
    );
    expect(getBatchFieldContract("plan.stage.create", "before").omission).toBe(
      "Поместить в конец списка.",
    );
    expect(getBatchFieldContract("plan.stage.move", "before").omission).toContain(
      "требуется direction",
    );
  });

  test("прикрепления различают отсутствующий состав, очистку и описание существующей пары", () => {
    expect(getBatchFieldContract("document.create", "targets").omission).toBe(
      "Если не переданы ни targets, ни relations, прикреплений нет.",
    );
    expect(getBatchFieldContract("document.update", "relations").omission).toBe(
      "Если не переданы ни targets, ни relations, прикрепления сохраняются.",
    );
    expect(getBatchFieldContract("document.link", "description").omission).toContain(
      "прежнее описание сохраняется",
    );
    expect(getBatchFieldContract("document.update", "sectionId").nullMeaning).toBe(
      "Снять документ с раздела.",
    );
  });

  test("история различает пропущенный текст, запрещённый null и наследование operator", () => {
    for (const [op, field] of [
      ["session.start", "description"],
      ["session.resume", "reason"],
      ["checkpoint.save", "summary"],
      ["checkpoint.complete", "checks"],
    ] as const) {
      expect(getBatchFieldContract(op, field)).toEqual({
        presence: "Необязательно.",
        omission: "При пропуске сохраняется null; явные null и пустая строка не принимаются.",
        nullable: false,
      });
    }
    expect(getBatchFieldContract("session.attach", "operator")).toMatchObject({
      nullable: true,
      omission: "При пропуске наследуется пользователь участия, создавшего дочернее поручение.",
      nullMeaning: "Не наследовать пользователя участия-создателя; сохранить operator:null.",
    });
    expect(getBatchFieldContract("session.resume", "operator").omission).toContain("равны null");
    expect(getBatchFieldContract("session.cancel", "runId")).toEqual({
      presence: "Обязательно для open; для pending/paused поле должно отсутствовать.",
      omission: "При pending/paused участие не требуется; при open пропуск приводит к ошибке.",
      nullable: false,
    });
  });

  test("производный prefix и пустая дата не подменяются null или случайным default схемы", () => {
    expect(getBatchFieldContract("application.create", "prefix").omission).toContain(
      "slug в верхнем регистре",
    );
    expect(getBatchFieldContract("release.create", "plannedFor")).toEqual({
      presence: "Необязательно.",
      omission: 'При пропуске сохраняется "": плановая дата не задана.',
      nullable: false,
    });
    expect(getBatchFieldContract("release.update", "plannedFor")).toEqual({
      presence: 'Необязательно; пустая строка "" снимает плановую дату.',
      omission: "Пропуск сохраняет текущее значение.",
      nullable: false,
    });
  });

  test("неизвестная операция и поле отклоняются как дефект метаданных", () => {
    expect(() => getBatchOperationContract("document.delete")).toThrow("Ошибка метаданных справки");
    expect(() => getBatchFieldContract("unknown", "title")).toThrow("неизвестная операция unknown");
    expect(() => getBatchFieldContract("task.create", "__proto__")).toThrow(
      "task.create.input.__proto__",
    );
    expect(() => getBatchFieldContract("plan.start", "title")).toThrow("plan.start.input.title");
  });
});

describe("Автономные JSON-примеры листов", () => {
  test.each(BATCH_OPERATIONS)(
    "$op соответствует descriptor и не требует необъявленного as",
    (operation) => {
      const { example } = getBatchOperationContract(operation.op);
      expect(example.op).toBe(operation.op);
      expect(Object.hasOwn(example, "ref")).toBe(operation.ref === "required");
      expect(Object.hasOwn(example, "ifRevision")).toBe(operation.revisionOwner !== null);
      if (example.ifRevision !== undefined) {
        expect(Number.isSafeInteger(example.ifRevision) && example.ifRevision > 0).toBe(true);
      }
      for (const field of Object.keys(example.input ?? {})) {
        expect(operation.inputFields).toContain(field);
      }
      for (const field of operation.inputFields) {
        if (requiredFields.has(`${operation.op}.${field}`)) {
          expect(Object.hasOwn(example.input ?? {}, field)).toBe(true);
        }
      }
      const json = JSON.stringify(example);
      expect(JSON.parse(json)).toEqual(example);
      expect(json).not.toContain('"$ref"');
      expect(json).not.toContain('"$revision"');
      expect(
        Object.keys(example).every((field) => ["op", "ref", "ifRevision", "input"].includes(field)),
      ).toBe(true);
    },
  );

  test("вложенные scope, operator, criteria и relations имеют предметную JSON-форму", () => {
    expect(getBatchOperationContract("plan.create").example.input?.scope).toEqual([
      { kind: "feature", id: "FEATURE-1" },
    ]);
    expect(getBatchOperationContract("session.start").example.input?.operator).toMatchObject({
      name: "Ирина",
      email: "irina@example.com",
      source: "explicit",
    });
    expect(historyOperatorSources).toContain("explicit");
    expect(getBatchOperationContract("task.create").example.input?.acceptanceCriteria).toEqual([
      {
        title: "Запрос сохраняется",
        summary: "Повтор не требует нового ввода",
        description: "## Проверка\nВызвать HTTP 503, повторить поиск и сравнить исходный запрос.",
      },
    ]);
    expect(getBatchOperationContract("document.create").example.input?.relations).toEqual([
      {
        target: { kind: "feature", id: "FEATURE-1" },
        type: "documents",
        description: "Правила приёмки **поиска товаров**.",
      },
    ]);
    expect(DOCUMENT_RELATION_TYPES).toContain("documents");
  });

  test("правила называют владельца CAS seed, приложения, обоих планов и сессии материала", () => {
    expect(getBatchOperationContract("product.create").rules.join(" ")).toContain(
      "ifRevision именно этого паспорта",
    );
    expect(getBatchOperationContract("implementation.create").rules.join(" ")).toContain(
      "ревизия этого приложения",
    );
    const transfer = getBatchOperationContract("plan.stage.task.transfer");
    expect(transfer.rules.join(" ")).toContain(
      "targetRevision обязателен и принадлежит targetPlan",
    );
    expect(transfer.example).toMatchObject({
      ref: "PLN-1",
      ifRevision: 1,
      input: { targetPlan: "PLN-2", targetRevision: 1 },
    });
    expect(getBatchOperationContract("checkpoint.complete").rules.join(" ")).toContain(
      "ifRevision принадлежит его сессии, не checkpoint",
    );
    expect(getBatchOperationContract("checkpoint.complete").rules.join(" ")).toContain(
      "currentRunId",
    );
  });
});
