import { writeFileSync } from "node:fs";
import { CommandExecutor, ProjectDatabase } from "@relay/core";
import { SyncEngine } from "../../../src/sync/engine";
import { ReplicationAdapter } from "../../../src/sync/replication-adapter";
import { DataRepository } from "../../../src/transport/repository";
import type { ProcessResult } from "../../../src/transport/process.types";
import type { ReplicationChangeset } from "@relay/contracts";
import { observeExchangeDatabase } from "./crash-exchange-state";
import type {
  ExchangeDatabaseState,
  ExchangeProcessInput,
  ExchangeProcessObservation,
} from "./crash-exchange.types";

// Закрытый протокол двух тестовых модулей: JSON создаёт типизированный runExchangeProcess.
const input = JSON.parse(await Bun.stdin.text()) as ExchangeProcessInput;
const database = ProjectDatabase.open(input.databasePath);
const replication = new ReplicationAdapter(database);
let candidate: string | null = null;
let beforePush: ExchangeDatabaseState | null = null;
let lateChange: ReplicationChangeset | null = null;

/**
 * Сохраняет наблюдение до непосредственного выхода; finally и database.close не исполняются.
 */
function crash(head: string): never {
  emit(head);
  process.exit(86);
}

/**
 * Синхронный вывод не теряется вместе с буфером stdout при process.exit.
 */
function emit(head: string): void {
  const observation: ExchangeProcessObservation = {
    point: input.point,
    pid: process.pid,
    head,
    beforePush,
    state: observeExchangeDatabase(database, replication),
    lateChange,
  };
  writeFileSync(1, JSON.stringify(observation));
}

/**
 * Выполняет назначенную команду ровно один раз через другой writer после materialization кандидата.
 */
async function writeLateCommand(): Promise<void> {
  if (!input.lateCommand) {
    return;
  }
  const writer = ProjectDatabase.open(input.databasePath);
  try {
    const before = writer.getReplicationOutbox().map((entry) => entry.id);
    await new CommandExecutor(writer).execute(input.lateCommand, { actor: "late-writer" });
    const created = writer.getReplicationOutbox().filter((entry) => !before.includes(entry.id));
    const change = created[0];
    if (created.length !== 1 || !change) {
      throw new Error("Поздняя команда обязана сохранить ровно один новый changeset");
    }
    lateChange = change;
  } finally {
    writer.close();
  }
}

/**
 * Test-only именованные barriers: реальный commit/push/accept делегируются приложению.
 */
class CrashRepository extends DataRepository {
  /**
   * A: кандидат уже durable; B: origin уже принял его, но Core ещё не видел успешный ответ.
   */
  override async push(commit: string): Promise<ProcessResult> {
    if (candidate !== null) {
      throw new Error("Fixture допускает ровно одну публикацию за попытку");
    }
    candidate = commit;
    await writeLateCommand();
    beforePush = observeExchangeDatabase(database, replication);
    if (input.point === "before-push") {
      crash(commit);
    }
    const result = await super.push(commit);
    if (input.point === "after-push" && result.exitCode === 0) {
      crash(commit);
    }
    return result;
  }

  /**
   * C: engine уже вернулся из атомарного Core accept, а Git accepted-ref ещё старый.
   */
  override async accepted(head: string): Promise<void> {
    if (input.point === "after-accept" && head === (input.acceptHead ?? candidate)) {
      crash(head);
    }
    await super.accepted(head);
  }
}

const repository = new CrashRepository(input.repository);
try {
  await repository.initialize();
  await new SyncEngine(
    input.directory,
    database.projectId,
    replication,
    repository,
    new AbortController().signal,
  ).run();
  if (input.point !== "complete") {
    throw new Error(`Engine не достиг аварийной границы ${input.point}`);
  }
  const head = await repository.acceptedCommit();
  if (head === null) {
    throw new Error("Восстановленный engine не сохранил accepted checkpoint");
  }
  emit(head);
} finally {
  // При crash process.exit обрывает стек до этого блока: главное соединение остаётся открытым.
  database.close();
}
