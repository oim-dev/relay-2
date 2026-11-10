import type { PortableProjectSnapshot, ReplicationHistoryInput } from "@relay/contracts";
import type { GitFiles, GitHistoryEntry } from "../transport/repository.types";
import type { ValidatedReplicationHistory } from "@relay/core";

/**
 * Git object reader проверяет фактические edges, Core проверяет переносимую форму и семантику.
 */
export interface PublicationRepository {
  /* Последний Git cursor, записанный после успешного Core accept. */
  acceptedCommit(): Promise<string | null>;
  /* Полный линейный путь после anchor, без first-parent пропусков. */
  history(head: string, after: string | null): Promise<GitHistoryEntry[]>;
  /* Один immutable Git snapshot tree. */
  files(head: string): Promise<Map<string, Uint8Array>>;
  /* Пакетное чтение деревьев с общими blobs. */
  filesMany(heads: readonly string[]): Promise<Map<string, Map<string, Uint8Array>>>;
}

/**
 * Предметная граница reader: никаких правил payload/tape/decision в Git-приложении.
 */
export interface PublicationRules {
  /* Проверяет файловое представление и делегирует DTO validation Core. */
  decode(files: GitFiles, projectId: string): PortableProjectSnapshot;
  /* Чистая проверка полной ordered chain, без local apply/ack и без пропуска промежуточных переходов. */
  validate(
    base: PortableProjectSnapshot | null,
    remote: PortableProjectSnapshot,
    history?: ReplicationHistoryInput,
  ): ValidatedReplicationHistory;
}

/**
 * Ограниченная пачка после локального accepted base; вызывающий принимает её последний snapshot.
 */
export interface PublicationBatch {
  /* Git commit последней публикации пачки. */
  readonly head: string;
  /* Все промежуточные snapshots в прямом порядке, включая последний. */
  readonly chain: readonly PortableProjectSnapshot[];
  /* Последняя canonical публикация, совпадающая с chain.at(-1). */
  readonly snapshot: PortableProjectSnapshot;
  /* Непереносимое Core доказательство полного checked suffix; никогда не сериализуется в Git/JSON. */
  readonly proof: ValidatedReplicationHistory;
}

/**
 * Контекст bounded replay; отсутствие consumer означает чистую проверку (refresh/restore).
 */
export interface PublicationReadOptions {
  /* Постоянный ID выбранного проекта. */
  readonly projectId: string;
  /* Фактически принятый Core snapshot, null для проверки с genesis. */
  readonly base: PortableProjectSnapshot | null;
  /* Уже декодированные immutable snapshots текущего процесса, обычно base/latest. */
  readonly cache?: ReadonlyMap<string, PortableProjectSnapshot>;
  /* Приём только полностью проверенной пачки; callback владеет Core transaction и обновлением cursor. */
  readonly consume?: (batch: PublicationBatch) => Promise<void>;
}
