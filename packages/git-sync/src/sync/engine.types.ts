import type {
  PortableProjectSnapshot,
  ReplicationStatus,
  ReplicationAcceptResult,
  ReplicationHistoryInput,
} from "@relay/contracts";
import type { GitFiles, GitCounts } from "../transport/repository.types";
import type { ProcessResult } from "../transport/process.types";
import type { PublicationRepository } from "./publication-reader.types";
import type {
  BoundedPreparedReplication,
  ReplicationPrepareOptions,
  ValidatedReplicationHistory,
} from "@relay/core";

/**
 * Узкий предметный порт, позволяющий проверять транспортные сбои независимо от SQL.
 * Production-реализация только делегирует Core.
 */
export interface ReplicationPort {
  /* Физический путь открытой SQLite; вместе с replicaId отделяет cursor чужой очереди. */
  readonly databaseIdentity: string;
  /* Проверяет durable pending и локальное поколение до повторной полной подготовки. */
  status(): ReplicationStatus;
  /* Точный принятый Core base; capture с publication:null его не заменяет. */
  acceptedSnapshot(): PortableProjectSnapshot | null;
  /* Чистый replay canonical chain, без observed/ack/local writes. */
  validateHistory(
    base: PortableProjectSnapshot | null,
    remote: PortableProjectSnapshot,
    history?: ReplicationHistoryInput,
  ): ValidatedReplicationHistory;
  /* Подготавливает валидный кандидат, сохраняя immutable IDs исходных операций. */
  prepare(
    remote: PortableProjectSnapshot | null,
    history?: ReplicationHistoryInput | ValidatedReplicationHistory,
    options?: ReplicationPrepareOptions,
  ): BoundedPreparedReplication;
  /* Атомарно применяет подтверждённый снимок с сохранением конкурентных локальных записей. */
  accept(
    snapshot: PortableProjectSnapshot,
    history?: ReplicationHistoryInput | ValidatedReplicationHistory,
  ): ReplicationAcceptResult;
}

/**
 * Единственный последний decoded remote, привязанный к неизменяемому Git object ID.
 */
export interface CachedRemoteSnapshot {
  /* Точный Git commit, из дерева которого декодирован снимок. */
  readonly head: string;
  /* Переносимые значения; предметные методы не изменяют переданный снимок. */
  readonly snapshot: PortableProjectSnapshot;
}

/**
 * Транспорт одной общей ветки. Fault injection в тестах заменяет только ответ Git push.
 */
export interface RepositoryPort extends PublicationRepository {
  /* Отмена scope не меняет конфигурацию repo; применяется ко всем командам текущей попытки. */
  setAttemptSignal(signal: AbortSignal | null): void;
  /* Получает текущий remote head или null при доказанном отсутствии новой ветки. */
  fetch(): Promise<string | null>;
  /* Читает snapshot tree напрямую из Git objects. */
  files(head: string): Promise<Map<string, Uint8Array>>;
  /* Сохраняет проверенный remote ref для диагностики и защиты от rewrite. */
  rememberRemote(head: string): Promise<void>;
  /* Готовит коммит непосредственно на полученном remote head. */
  commit(files: GitFiles, parent: string | null): Promise<string>;
  /* Публикует обычным FF push без force. */
  push(commit: string): Promise<ProcessResult>;
  /* Проверяет принятие отправленного коммита при потерянном ответе push. */
  isAncestor(ancestor: string, head: string): Promise<boolean>;
  /* Отмечает подтверждённую локальную и удалённую стороны после Core acceptance. */
  accepted(head: string): Promise<void>;
  /* Вычисляет истинные Git counts после изменения refs; обычный status использует сохранённый результат. */
  counts(): Promise<GitCounts>;
}

/**
 * Статус outbox отдельно от истории Git.
 */
export interface PendingStatus {
  /* Durable неподтверждённые транзакции Core. */
  readonly changesets: ReplicationStatus["pending"];
  /* ISO старейшей записи или null. */
  readonly oldest: ReplicationStatus["oldest"];
  /* Ещё не материализованные changeset; null, когда кандидат устарел относительно поколения. */
  readonly unexported: number | null;
}
