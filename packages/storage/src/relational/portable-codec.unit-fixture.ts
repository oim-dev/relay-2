import type {
  EntityKind,
  PortableComponent,
  PortableEntity,
  PortableEntityRecord,
  PortableProjectSnapshot,
  ReplicationPublication,
} from "@relay/contracts";

export const codecIds = {
  project: "00000000-0000-4000-8000-000000000001",
  product: "00000000-0000-4000-8000-000000000002",
  board: "00000000-0000-4000-8000-000000000003",
  document: "00000000-0000-4000-8000-000000000004",
  task: "00000000-0000-4000-8000-000000000005",
  dependency: "00000000-0000-4000-8000-000000000006",
  feature: "00000000-0000-4000-8000-000000000007",
  scenario: "00000000-0000-4000-8000-000000000008",
  application: "00000000-0000-4000-8000-000000000009",
  appBoard: "00000000-0000-4000-8000-000000000010",
  implementation: "00000000-0000-4000-8000-000000000011",
  plan: "00000000-0000-4000-8000-000000000012",
  release: "00000000-0000-4000-8000-000000000013",
  session: "00000000-0000-4000-8000-000000000014",
  child: "00000000-0000-4000-8000-000000000015",
  intent: "00000000-0000-4000-8000-000000000016",
  result: "00000000-0000-4000-8000-000000000017",
} as const;

export const codecTime = "2026-11-17T08:00:00.000Z";
export const codecBody = "\ufeff# Точный текст\r\n\tСтрока  \r\nnul:\0\n";
export const codecReceipt = {
  operationKey: "original-operation",
  requestJson: '{ "actor": "Автор", "commands": [ ] }\r\n',
  resultJson:
    '{"operationKey":"original-operation","revision":73,"key":"OLD-7","text":"\\ud800"}\n',
} as const;

const partMetadata = {
  position: "V",
  version: "b".repeat(64),
  parents: ["a".repeat(64)],
  deleted: false,
} as const;

/**
 * Создаёт небольшой model 2 для физических колонок документа и типизированной цели задачи.
 * Fixture не использует SQLite и не вычисляет ожидания через проверяемый codec.
 */
export function createPortableCodecFixture(): PortableProjectSnapshot {
  const entities = [
    fixtureEntity(codecIds.project, "project", "project", { name: "Проект", slug: "project" }),
    fixtureEntity(codecIds.product, "product", "PRODUCT", {}),
    fixtureEntity(codecIds.board, "board", "BOARD", {
      name: "Доска",
      slug: "product",
      prefix: "TASK",
    }),
    fixtureEntity(codecIds.document, "document", "DOC-7", {
      name: "Документ",
      summary: "Непарный:\ud800",
      body: codecBody,
      documentKind: "specification",
      documentStatus: "active",
      sectionId: null,
      pinned: true,
    }),
    fixtureEntity(codecIds.task, "task", "TASK-1", {
      boardId: codecIds.board,
      title: "Задача",
      description: "",
      column: "inbox",
      parentId: null,
    }),
    fixtureEntity(codecIds.feature, "feature", "FEAT-1", {
      name: "Текущее имя фичи",
      summary: "",
      description: "",
    }),
  ];
  return snapshotFixture(entities, [
    {
      ...partMetadata,
      ownerId: codecIds.task,
      kind: "task-target",
      id: "target-assignment",
      value: { targetId: codecIds.feature },
    },
  ]);
}

/**
 * Создаёт полный состав: scoped части, tombstones, история, переносимые proof и исходная receipt.
 * Фиксированные версии проверяют сохранность, а не криптографическую проверку Core.
 */
export function createComposedPortableFixture(): PortableProjectSnapshot {
  const base = createPortableCodecFixture();
  const entities = [
    ...base.entities.map((entity) =>
      entity.record.id === codecIds.document
        ? {
            ...entity,
            record: { ...entity.record, data: { ...entity.record.data, sectionId: "section-1" } },
          }
        : entity,
    ),
    fixtureEntity(codecIds.dependency, "task", "TASK-2", {
      boardId: codecIds.board,
      title: "Основание",
      description: "",
      column: "inbox",
      parentId: codecIds.task,
    }),
    fixtureEntity(codecIds.scenario, "scenario", "SCEN-1", {
      featureId: codecIds.feature,
      name: "Сценарий",
      summary: "",
      description: "",
    }),
    fixtureEntity(codecIds.application, "application", "APP-1", {
      name: "Приложение",
      summary: "",
      description: "",
      slug: "frontend",
      type: "frontend",
      boardId: codecIds.appBoard,
      prefix: "APP",
    }),
    fixtureEntity(codecIds.appBoard, "board", "APP-BOARD", {
      name: "Доска приложения",
      slug: "frontend",
      prefix: "APP",
      applicationId: codecIds.application,
    }),
    fixtureEntity(codecIds.implementation, "implementation", "IMPL-1", {
      title: "Реализация",
      description: "",
      status: "partial",
      applicationId: codecIds.application,
      featureId: codecIds.feature,
      scenarioId: codecIds.scenario,
      targetId: codecIds.scenario,
      targetKind: "scenario",
      active: true,
    }),
    fixtureEntity(codecIds.plan, "work-plan", "PLAN-1", {
      projectId: codecIds.project,
      title: "План",
      summary: "",
      goal: "",
      rationale: "",
      boundaries: "",
      expectedResult: "",
      result: "",
      status: "draft",
      startedAt: null,
      closedAt: null,
    }),
    fixtureEntity(codecIds.release, "release", "REL-1", {
      projectId: codecIds.project,
      title: "Релиз",
      version: "1.0",
      summary: "",
      description: "",
      plannedFor: "",
      status: "planned",
      releasedAt: null,
      releasedBy: null,
    }),
    fixtureEntity(codecIds.session, "work-session", "SESSION-1", {
      title: "Работа",
      description: null,
      status: "open",
      parentSessionId: null,
      originCheckpointId: null,
      createdByRunId: null,
      result: null,
      closedAt: null,
      currentRunId: "run-2",
    }),
    fixtureEntity(codecIds.child, "work-session", "SESSION-2", {
      title: "Поручение",
      description: "",
      status: "completed",
      parentSessionId: codecIds.session,
      originCheckpointId: codecIds.intent,
      createdByRunId: "run-1",
      result: "Сделано",
      closedAt: codecTime,
      currentRunId: null,
    }),
    fixtureEntity(codecIds.intent, "work-checkpoint", "CHECK-1", {
      ...checkpointData(),
      kind: "intent",
      intentId: null,
      sequence: 1,
      sessionRevision: 2,
      references: [
        { id: codecIds.feature, kind: "feature", key: "OLD-FEATURE", title: "Историческое:\udc00" },
      ],
      acceptedSessionIds: [],
    }),
    fixtureEntity(codecIds.result, "work-checkpoint", "CHECK-2", {
      ...checkpointData(),
      kind: "result",
      intentId: codecIds.intent,
      sequence: 2,
      sessionRevision: 9,
      references: [
        { id: codecIds.task, kind: "task", key: "OLD-TASK", title: "Прежняя задача" },
        { id: codecIds.document, kind: "document", key: "OLD-DOC", title: "Прежний документ" },
      ],
      acceptedSessionIds: [codecIds.child],
    }),
  ];
  const components: PortableComponent[] = [
    ...(base.components ?? []).filter((part) => part.kind !== "address-assignment"),
    {
      ...partMetadata,
      ownerId: codecIds.task,
      kind: "collection",
      id: "acceptanceCriteria",
      value: { field: "acceptanceCriteria" },
    },
    {
      ...partMetadata,
      ownerId: codecIds.task,
      kind: "task-criterion",
      id: "criterion-1",
      value: {
        id: "criterion-1",
        title: "Критерий",
        summary: " \r\n",
        description: "\udfff",
        completed: false,
        completedAt: null,
        completedBy: null,
      },
    },
    {
      ...partMetadata,
      ownerId: codecIds.dependency,
      kind: "task-criterion",
      id: "criterion-1",
      position: "a1",
      deleted: true,
      value: {
        id: "criterion-1",
        title: "Снятый критерий",
        summary: "",
        description: "",
        completed: true,
        completedAt: codecTime,
        completedBy: "Автор",
      },
    },
    {
      ...partMetadata,
      ownerId: codecIds.task,
      kind: "task-dependency",
      id: "dependency-assignment",
      value: { taskId: codecIds.dependency },
    },
    {
      ...partMetadata,
      ownerId: codecIds.task,
      kind: "task-related",
      id: "relation-assignment",
      deleted: true,
      value: { taskId: codecIds.dependency },
    },
    {
      ...partMetadata,
      ownerId: codecIds.plan,
      kind: "plan-stage",
      id: "stage-1",
      position: "a2",
      value: { id: "stage-1", title: "Этап", summary: "", outcome: "", completionConditions: "" },
    },
    {
      ...partMetadata,
      ownerId: codecIds.plan,
      kind: "plan-task",
      id: "membership-1",
      position: "a3",
      value: { stageId: "stage-1", taskId: codecIds.task },
    },
    {
      ...partMetadata,
      ownerId: codecIds.plan,
      kind: "plan-scope",
      id: "scope-1",
      value: { id: codecIds.feature, kind: "feature" },
    },
    {
      ...partMetadata,
      ownerId: codecIds.plan,
      kind: "plan-participant",
      id: "participant-1",
      value: { participant: "\ud800 Участник " },
    },
    {
      ...partMetadata,
      ownerId: codecIds.release,
      kind: "release-plan",
      id: "release-plan-1",
      value: { planId: codecIds.plan },
    },
    {
      ...partMetadata,
      ownerId: codecIds.document,
      kind: "document-relation",
      id: "document-relation-1",
      value: {
        target: { kind: "feature", id: codecIds.feature },
        type: "documents",
        description: "Описание:\ud800",
      },
    },
    {
      ...partMetadata,
      ownerId: codecIds.project,
      kind: "document-section",
      id: "section-1",
      value: { id: "section-1", name: "Раздел" },
    },
    {
      ...partMetadata,
      ownerId: codecIds.project,
      kind: "document-section",
      id: "section-old",
      deleted: true,
      value: { id: "section-old", name: "Исторический раздел" },
    },
    {
      ...partMetadata,
      ownerId: codecIds.project,
      kind: "section-reservation",
      id: "section-old",
      value: { sectionId: "section-old" },
    },
    {
      ...partMetadata,
      ownerId: codecIds.application,
      kind: "application-participation",
      id: "participation-1",
      value: { implementationId: codecIds.implementation },
    },
    {
      ...partMetadata,
      ownerId: codecIds.session,
      kind: "session-run",
      id: "run-1",
      value: {
        ...runData("run-1"),
        state: "transferred",
        endedAt: codecTime,
        endReason: "Передано",
      },
    },
    {
      ...partMetadata,
      ownerId: codecIds.session,
      kind: "session-run",
      id: "run-2",
      position: "a1",
      value: {
        ...runData("run-2"),
        predecessorRunId: "run-1",
        operator: { name: "Имя:\ud800", email: null, source: "explicit" },
      },
    },
    {
      ...partMetadata,
      ownerId: codecIds.child,
      kind: "session-run",
      id: "run-1",
      value: { ...runData("run-1"), state: "completed", endedAt: codecTime, endReason: "Готово" },
    },
    {
      ...partMetadata,
      ownerId: codecIds.document,
      kind: "address-assignment",
      id: "retired-address",
      deleted: true,
      value: { ref: "RETIRED-1" },
    },
  ];
  const snapshot = snapshotFixture(entities, components);
  const publication = fixturePublication();
  return {
    ...snapshot,
    receipts: [codecReceipt],
    confirmations: [
      {
        replicaId: "replica",
        ranges: [[1, 1]],
        proofs: [
          {
            sequence: 1,
            digest: "c".repeat(64),
            publicationId: publication.publicationId,
            resolutionId: null,
            effectDigest: "d".repeat(64),
            outcome: "applied",
          },
        ],
      },
    ],
    publication,
  };
}

/**
 * Создаёт raw owner с неизменяемым временем/авторством и отличимой переносимой версией.
 */
function fixtureEntity(
  id: string,
  kind: EntityKind,
  key: string,
  data: PortableEntityRecord["data"],
): PortableEntity {
  return {
    record: {
      id,
      kind,
      key,
      createdAt: codecTime,
      updatedAt: codecTime,
      createdBy: "Автор",
      updatedBy: "Автор",
      data,
    },
    version: "e".repeat(64),
    parents: [],
  };
}

/**
 * Дополняет заданные владельцы точными адресными частями и независимым комментарием.
 */
function snapshotFixture(
  entities: PortableEntity[],
  parts: readonly PortableComponent[],
): PortableProjectSnapshot {
  const addresses = entities
    .flatMap(({ record }) => [
      { ref: record.id, entityId: record.id },
      { ref: record.key, entityId: record.id },
    ])
    .sort((a, b) => (a.ref < b.ref ? -1 : 1));
  const components: PortableComponent[] = [
    ...parts,
    ...addresses.map((address): PortableComponent<"address-assignment"> => ({
      ...partMetadata,
      id: `assignment:${address.ref}`,
      ownerId: address.entityId,
      kind: "address-assignment",
      value: { ref: address.ref },
    })),
  ];
  components.sort((a, b) =>
    JSON.stringify([a.ownerId, a.kind, a.id]) < JSON.stringify([b.ownerId, b.kind, b.id]) ? -1 : 1,
  );
  return {
    formatVersion: 1,
    modelVersion: 2,
    projectId: codecIds.project,
    entities: [...entities].sort((a, b) => (a.record.id < b.record.id ? -1 : 1)),
    components,
    addresses,
    comments: [
      {
        taskId: codecIds.task,
        after: null,
        comment: {
          id: "comment-1",
          title: "Точный:\ud800",
          body: codecBody,
          createdAt: codecTime,
          createdBy: "Автор",
        },
      },
    ],
    receipts: [],
    confirmations: [],
    publication: null,
  };
}

/**
 * Задаёт общие поля неизменяемого материала; scoped run относится к родительской сессии.
 */
function checkpointData(): PortableEntityRecord["data"] {
  return {
    sessionId: codecIds.session,
    runId: "run-1",
    actor: "Автор",
    title: "Материал",
    body: codecBody,
    summary: null,
    done: null,
    remaining: null,
    nextStep: null,
    checks: null,
  };
}

/**
 * Задаёт исходное участие с nullable operator, сохраняя заданный scoped ID и ключ.
 */
function runData(id: string): PortableComponent<"session-run">["value"] {
  return {
    id,
    key: `RUN-${id}`,
    actor: "Автор",
    state: "active",
    reason: null,
    operator: null,
    client: "\ud800",
    sourceSessionId: "external/session",
    predecessorRunId: null,
    startedAt: codecTime,
    endedAt: null,
    endReason: null,
  };
}

/**
 * Сохраняет независимый original source с первоначальной receipt и ordered boundary.
 */
function fixturePublication(): ReplicationPublication {
  const originalDocument = fixtureEntity(codecIds.document, "document", "ORIGINAL-7", {
    name: "Первоначальное название",
    summary: "",
    body: "Первоначальная версия:\ud800\r\n",
    documentKind: "specification",
    documentStatus: "draft",
    sectionId: null,
    pinned: false,
  });
  const originalEffects = [{ id: codecIds.document, before: null, after: originalDocument }];
  const transition = {
    command: "receipt-only",
    actor: "Автор",
    timestamp: codecTime,
    targets: { primaryId: null, ownerIds: [], roles: { document: null } },
    entities: originalEffects,
    components: [],
    addresses: [],
    comments: [],
    receipts: [codecReceipt],
    readContext: [],
    predicates: [
      {
        selector: { kind: "receipt" as const, operationKey: "original-operation" },
        records: [],
        present: false,
      },
    ],
  };
  return {
    formatVersion: 1,
    publicationId: "f".repeat(64),
    parent: { publicationId: "1".repeat(64), snapshotDigest: "2".repeat(64) },
    snapshotDigest: "3".repeat(64),
    accepted: [
      {
        changesetId: "replica:1",
        sourceDigest: "c".repeat(64),
        resolutionId: null,
        effectDigest: "d".repeat(64),
      },
    ],
    changes: [
      {
        source: {
          formatVersion: 1,
          modelVersion: 2,
          projectId: codecIds.project,
          digest: "c".repeat(64),
          mode: "mutation",
          id: "replica:1",
          replicaId: "replica",
          sequence: 1,
          createdAt: codecTime,
          dependencies: [],
          readContext: [],
          entities: originalEffects,
          components: [],
          addresses: [],
          comments: [],
          receipts: [codecReceipt],
          transitions: [transition],
        },
        resolution: null,
        transitions: [transition],
      },
    ],
  };
}
