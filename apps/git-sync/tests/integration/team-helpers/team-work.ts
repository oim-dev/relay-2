import { expect } from "bun:test";
import { BatchService, KnowledgeService, TasksService } from "@relay/core";
import type { PortableProjectSnapshot } from "@relay/contracts";
import type { TeamReplica } from "./team-fixture.types";
import type { IndependentWork, OfflineCreation } from "./team-scenario.types";
import { storedEntity } from "./team-state";

/**
 * Создаёт две связанные записи до сети. Обе читаемые адреса совпадают у всех участников.
 * Нужны именно две записи: перенумеровываются и источник связи, и её цель по ID.
 * Дожидается commit задачи до создания ссылающегося документа и чтения outbox.
 */
export async function createOffline(replica: TeamReplica): Promise<OfflineCreation> {
  const actor = `participant-${replica.index}`;
  const task = await new TasksService(replica.db).create(
    { title: `Работа ${replica.index}` },
    actor,
  );
  const body = `# Участник ${replica.index}\r\n\tТочно: ё и e\u0301  \r\n[Задача](relay://${replica.db.projectId}/${task.id})\n\`DOC-2\` — обычный текст без финального LF`;
  const document = await new KnowledgeService(replica.db).create(
    "document",
    {
      name: `Документ ${replica.index}`,
      body,
      relations: [
        {
          target: { kind: "task", id: task.id },
          type: "documents",
          description: `Связь ${replica.index}`,
        },
      ],
    },
    actor,
  );
  const changesets = replica.db.getReplicationOutbox();
  expect(changesets).toHaveLength(2);
  expect(changesets[1]?.dependencies).toContain(changesets[0]?.id);
  return { index: replica.index, document, task, changesets };
}

/**
 * Сохраняет точечную правку, независимый комментарий и один batch двух связанных владельцев.
 * Проверяет границу outbox и исходную квитанцию до любого обмена; команды не воспроизводятся при retry.
 * Записи выполняются последовательно и завершаются до возврата, включая отказ сценария.
 */
export async function createIndependentWork(
  replica: TeamReplica,
  initial: OfflineCreation,
  commonTaskId: string,
): Promise<IndependentWork> {
  const actor = `participant-${replica.index}`;
  const knowledge = new KnowledgeService(replica.db);
  const tasks = new TasksService(replica.db);
  const document = knowledge.get("document", initial.document.id);
  const updated = await knowledge.update(
    "document",
    document.id,
    { summary: `Правка ${replica.index}` },
    { actor, ifRevision: document.revision },
  );
  const common = tasks.get(commonTaskId);
  const commented = await tasks.comment(
    commonTaskId,
    `Комментарий ${replica.index}\r\n**Не повторять**`,
    actor,
  );
  const comment = commented.data.comments.at(-1);
  if (comment === undefined) {
    throw new Error("Команда не вернула новый комментарий");
  }
  expect(commented.revision).toBe(common.revision);
  const task = tasks.get(initial.task.id);
  const operationKey = `team-work-${replica.index}`;
  const result = await new BatchService(replica.db).execute(
    {
      version: 1,
      operations: [
        {
          op: "document.update",
          ref: document.id,
          ifRevision: updated.revision,
          input: { pinned: true },
        },
        {
          op: "task.update",
          ref: task.id,
          ifRevision: task.revision,
          input: { description: `Пакет ${replica.index}: сохранены обе стороны` },
        },
      ],
    },
    { actor, operationKey },
  );
  const changesets = replica.db.getReplicationOutbox();
  expect(changesets).toHaveLength(3);
  const atomic = changesets[2];
  if (atomic === undefined) {
    throw new Error("Пакет не появился в outbox");
  }
  expect(atomic.entities.map((entry) => entry.id).sort()).toEqual([document.id, task.id].sort());
  expect(atomic.receipts).toHaveLength(1);
  const receipt = atomic.receipts[0];
  if (receipt === undefined) {
    throw new Error("Отсутствует квитанция атомарного пакета");
  }
  expect(receipt.operationKey).toBe(operationKey);
  expect(JSON.parse(receipt.resultJson)).toEqual(result);
  expect(result.items.map((item) => item.id)).toEqual([document.id, task.id]);
  expect(result.entities.find((entry) => entry.id === document.id)).toMatchObject({
    kind: "document",
    data: { pinned: true },
  });
  expect(result.entities.find((entry) => entry.id === task.id)).toMatchObject({
    kind: "task",
    data: { description: `Пакет ${replica.index}: сохранены обе стороны` },
  });
  return { operationKey, result, receipt, comment, changesets };
}

/**
 * Проверяет каждую исходную пару ID/текст/связь и единственность ключей после коллизий.
 */
export function expectCreationsPreserved(
  snapshot: PortableProjectSnapshot,
  creations: readonly OfflineCreation[],
  winner: OfflineCreation,
): void {
  const documentIds = new Set(creations.map((entry) => entry.document.id));
  expect(snapshot.entities.filter((entry) => documentIds.has(entry.record.id))).toHaveLength(
    creations.length,
  );
  const keys: string[] = [];
  const taskKeys: string[] = [];
  for (const initial of creations) {
    const document = storedEntity(snapshot, initial.document.id).record;
    const task = storedEntity(snapshot, initial.task.id).record;
    expect(document.data.body).toBe(initial.document.data.body);
    const relations = snapshot.components?.filter(
      (part) => part.ownerId === document.id && part.kind === "document-relation" && !part.deleted,
    );
    expect(relations?.map((part) => part.value)).toEqual([
      {
        target: { kind: "task", id: task.id },
        type: "documents",
        description: `Связь ${initial.index}`,
      },
    ]);
    expect(task.data.title).toBe(`Работа ${initial.index}`);
    expect(snapshot.addresses.find((entry) => entry.ref === document.key)?.entityId).toBe(
      document.id,
    );
    expect(snapshot.addresses.find((entry) => entry.ref === task.key)?.entityId).toBe(task.id);
    expect(snapshot.addresses.find((entry) => entry.ref === document.id)?.entityId).toBe(
      document.id,
    );
    keys.push(document.key);
    taskKeys.push(task.key);
  }
  expect(new Set(keys).size).toBe(creations.length);
  expect(new Set(taskKeys).size).toBe(creations.length);
  expect(storedEntity(snapshot, winner.document.id).record.key).toBe(winner.document.key);
  expect(snapshot.addresses.find((entry) => entry.ref === "DOC-2")?.entityId).toBe(
    winner.document.id,
  );
}

/**
 * Проверяет все комментарии и результаты второй волны независимо от равенства реплик.
 * Для участника 0 явно учитывает позднюю независимую правку и разрешённый конфликтный пакет.
 */
export function expectIndependentWorkPreserved(
  snapshot: PortableProjectSnapshot,
  creations: readonly OfflineCreation[],
  work: readonly IndependentWork[],
  commonTaskId: string,
): void {
  expect(snapshot.comments).toHaveLength(work.length);
  expect(new Set(snapshot.comments.map((entry) => entry.comment.id)).size).toBe(work.length);
  for (const [index, operation] of work.entries()) {
    const initial = creations[index];
    if (initial === undefined) {
      throw new Error("Нет исходной пары для участника");
    }
    expect(
      snapshot.comments.find((entry) => entry.comment.id === operation.comment.id),
    ).toMatchObject({ taskId: commonTaskId, comment: operation.comment });
    expect(
      snapshot.receipts.find((entry) => entry.operationKey === operation.operationKey),
    ).toEqual(operation.receipt);
    expect(storedEntity(snapshot, initial.document.id).record.data).toMatchObject({
      pinned: true,
      summary: index === 0 ? "Независимая правка после конфликта" : `Правка ${index}`,
    });
    expect(storedEntity(snapshot, initial.task.id).record.data.description).toBe(
      index === 0
        ? "Атомарный спутник конфликтного текста"
        : `Пакет ${index}: сохранены обе стороны`,
    );
  }
}
