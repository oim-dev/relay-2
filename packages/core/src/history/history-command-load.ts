import {
  RelayError,
  type EntityRecord,
  type HistoryCheckpoint,
  type HistoryCheckpointAction,
  type HistorySession,
} from "@relay/contracts";
import type { CommandContext } from "../commands/command-context";
import { entityMessages } from "../entities/entity.messages";
import { decodeHistoryCheckpoint, decodeHistorySession } from "./history-data";
import { invalidHistoryInput } from "./history-input";
import type { HistoryCheckpointValues, HistoryTransition } from "./history-input.types";
import type { HistoryCommandState, HistoryReferenceState } from "./history-command.types";
import { historyInputMessages, historyStateMessages } from "./history-messages";
import { historyConflict } from "./history-rules";

const HISTORY_ID_CANDIDATE_LIMIT = 32;

/**
 * Выбирает свободный UUID до расчёта плана. Коллизии кандидатов не переисполняют команду.
 * Проверяет literal ID/S-/CP-/RUN- и все ранее выданные run, включая завершённые.
 * Резервы ещё не сохранённых выделений принадлежат общему CommandContext.
 */
export async function allocateHistoryId(commands: CommandContext): Promise<string> {
  for (let attempt = 0; attempt < HISTORY_ID_CANDIDATE_LIMIT; attempt++) {
    const id = commands.allocateId();
    let occupied = false;
    for (const prefix of ["", "S-", "CP-", "RUN-"]) {
      if ((await commands.identity(`${prefix}${id}`)) !== null) {
        occupied = true;
        break;
      }
    }
    if (!occupied && !(await commands.arrayItemExists("work-session", "runs", "id", id))) {
      return id;
    }
  }
  return historyConflict(historyStateMessages.allocationExhausted);
}

/**
 * Объединяет выбранные записи по постоянному ID, не расширяя область чтения.
 */
function uniqueHistoryRecords<T extends EntityRecord>(records: readonly T[]): T[] {
  return [...new Map(records.map((record) => [record.id, record])).values()];
}

/**
 * Читает продолжения intent независимо от sessionId, включая отрицательный предикат закрытия.
 */
async function loadIntentMaterials(
  commands: CommandContext,
  intentId: string,
): Promise<HistoryCheckpoint[]> {
  return (await commands.byField("work-checkpoint", "intentId", intentId)).map(
    decodeHistoryCheckpoint,
  );
}

/**
 * Объединяет обе обратные ссылки детей: повреждённая половина происхождения не скрывает строку.
 * Все originCheckpointId выбираются одним набором; пустой набор не делает SQL-запрос.
 */
async function loadHistoryChildren(
  commands: CommandContext,
  sessionId: string,
  intentIds: readonly string[],
): Promise<HistorySession[]> {
  const records = await commands.byField("work-session", "parentSessionId", sessionId);
  records.push(...(await commands.byFields("work-session", "originCheckpointId", intentIds)));
  return uniqueHistoryRecords(records).map(decodeHistorySession);
}

/**
 * Загружает принимаемых детей одним getMany, переиспользуя выбранный состав.
 * Обычный сервис принимает только постоянные IDs; batch раскрывает локальные ссылки до loader.
 */
async function loadAcceptedSessions(
  commands: CommandContext,
  ids: readonly string[],
  known: readonly HistorySession[],
): Promise<HistorySession[]> {
  const selected = new Map(known.map((session) => [session.id, session]));
  const missing = ids.filter((id) => !selected.has(id));
  if (missing.length > 0) {
    for (const record of await commands.getMany(missing, "work-session")) {
      selected.set(record.id, decodeHistorySession(record));
    }
  }
  for (const id of ids) {
    if (!selected.has(id)) {
      const identity = await commands.resolve(id, "work-session");
      if (identity.id !== id) {
        invalidHistoryInput(historyInputMessages.acceptedIdRequired);
      }
      throw new RelayError("CORRUPT_DATA", entityMessages.missingResolvedRecord, 1, { id });
    }
  }
  return [...selected.values()];
}

/**
 * Разрешает адреса целей и читает их одним пакетом; дубликаты ID запрещены.
 */
async function loadHistoryReferences(
  commands: CommandContext,
  references: readonly string[],
): Promise<HistoryReferenceState> {
  const ids: string[] = [];
  for (const ref of references) {
    const identity = await commands.resolve(ref);
    if (ids.includes(identity.id)) {
      invalidHistoryInput(historyInputMessages.duplicateReference);
    }
    ids.push(identity.id);
  }
  if (ids.length === 0) {
    return { records: [], projectId: commands.projectId, project: null };
  }
  const records = await commands.getMany(ids);
  if (records.length !== ids.length) {
    throw new RelayError("CORRUPT_DATA", entityMessages.missingResolvedRecord);
  }
  const project = records.some((record) => record.kind === "document")
    ? await commands.get(commands.projectId, "project")
    : null;
  return { records, projectId: commands.projectId, project };
}

/**
 * Получает конечный контекст перехода сессии. Закрытие читает только её материалы и детей;
 * fork — только исходный intent, attach — родителя и исходный материал создателя.
 * Закрытие выполняет не более четырёх field-выборок независимо от числа intent.
 */
export async function loadHistoryTransition(
  commands: CommandContext,
  session: HistorySession,
  intent: HistoryCheckpoint | null,
  input: HistoryTransition,
): Promise<HistoryCommandState> {
  const sessions = [session];
  let checkpoints: HistoryCheckpoint[] = intent === null ? [] : [intent];
  if (input.action === "fork" && intent !== null) {
    checkpoints.push(...(await loadIntentMaterials(commands, intent.id)));
  } else if (input.action === "attach") {
    if (session.data.parentSessionId === null || session.data.originCheckpointId === null) {
      historyConflict(historyStateMessages.creatorRunMissing);
    }
    sessions.push(
      decodeHistorySession(await commands.get(session.data.parentSessionId, "work-session")),
    );
    checkpoints.push(
      decodeHistoryCheckpoint(
        await commands.get(session.data.originCheckpointId, "work-checkpoint"),
      ),
    );
  } else if (input.action === "complete" || input.action === "cancel") {
    checkpoints = (await commands.byField("work-checkpoint", "sessionId", session.id)).map(
      decodeHistoryCheckpoint,
    );
    const intentIds = checkpoints
      .filter((entry) => entry.data.kind === "intent")
      .map((entry) => entry.id);
    checkpoints.push(
      ...(await commands.byFields("work-checkpoint", "intentId", intentIds)).map(
        decodeHistoryCheckpoint,
      ),
    );
    sessions.push(...(await loadHistoryChildren(commands, session.id, intentIds)));
  }
  return {
    session,
    intent,
    sessions: uniqueHistoryRecords(sessions),
    checkpoints: uniqueHistoryRecords(checkpoints),
    references: { records: [], projectId: commands.projectId, project: null },
  };
}

/**
 * Загружает sequence-set сессии, отдельный intent-set, цели и принимаемых детей.
 * При закрытии добавляет union детей обеих обратных связей, включая пустые множества.
 */
export async function loadHistoryCheckpoint(
  commands: CommandContext,
  session: HistorySession,
  intent: HistoryCheckpoint | null,
  action: HistoryCheckpointAction,
  input: HistoryCheckpointValues,
): Promise<HistoryCommandState> {
  const materials = (await commands.byField("work-checkpoint", "sessionId", session.id)).map(
    decodeHistoryCheckpoint,
  );
  let children: HistorySession[] = [];
  if (intent !== null) {
    materials.push(intent, ...(await loadIntentMaterials(commands, intent.id)));
    if (action === "complete" || action === "cancel") {
      children = await loadHistoryChildren(commands, session.id, [intent.id]);
    }
    children = await loadAcceptedSessions(commands, input.acceptedSessionIds, children);
  }
  return {
    session,
    intent,
    sessions: uniqueHistoryRecords([session, ...children]),
    checkpoints: uniqueHistoryRecords(materials),
    references: await loadHistoryReferences(commands, input.references),
  };
}
