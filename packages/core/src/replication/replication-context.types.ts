import type {
  PortableProjectSnapshot,
  ReplicationChangeset,
  ReplicationConflict,
} from "@relay/contracts";
import type {
  ReplicationState,
  StoredReplicationDecision,
  ReplicationOutboxRequest,
  ReplicationOutboxWindow,
  ReplicationSourceDigest,
} from "@relay/storage";

/**
 * Согласованный материал чистой подготовки, загруженный до вычислений вне write transaction.
 */
export interface ReplicationContext {
  /* Точный текущий локальный снимок, включая более поздние неподтверждённые записи. */
  readonly local: PortableProjectSnapshot;
  /* Выбранное окно либо полная durable очередь для accept/resolve. */
  readonly outbox: readonly ReplicationChangeset[];
  /* Полный witness требуется только для выбранного решения; иначе совпадает с outbox. */
  readonly decisionOutbox: readonly ReplicationChangeset[];
  /* Metadata выбранных sources и новых own proofs вне окна; не доказательство публикации. */
  readonly sources: readonly ReplicationSourceDigest[];
  /* null у явно полного overlay; prepare всегда читает ограниченное окно. */
  readonly window: ReplicationOutboxWindow | null;
  /* Явные сохранённые решения, актуальность которых повторно проверяет алгоритм. */
  readonly decisions: readonly StoredReplicationDecision[];
  /* Диагностика последней подготовки в том же локальном снимке. */
  readonly conflicts: readonly ReplicationConflict[];
  /* Последняя принятая база и локальный номер доставки. */
  readonly state: ReplicationState;
  /* Поколение предметного состояния прочитанного снимка. */
  readonly generation: number;
  /* Guard состояния служебного commit, включая receipt-only sequence и решения. */
  readonly token: string;
}

/**
 * Ограничивает загрузку технического контекста ответственностью вызывающего сценария.
 */
export interface ReplicationContextLoadOptions {
  /* pending не читает полный local snapshot, когда pure prepare не имеет ни одного local effect. */
  readonly capture?: "always" | "pending";
  /* Полные прошлые материалы нужны только resolve. */
  readonly conflicts?: boolean;
  /* Явный bounded select для prepare; отсутствие означает полный local overlay. */
  readonly window?: ReplicationOutboxRequest;
  /* Предъявленный remote для адресной сверки own proofs вне выбранного окна. */
  readonly remote?: PortableProjectSnapshot | null;
}

/**
 * Локальный verified checkpoint после атомарного импорта без оставшейся очереди.
 */
export interface CachedReplicationSnapshot {
  /* Exact scalar guard, снятый внутри той же write transaction после import/ack. */
  readonly guard: string;
  /* Immutable raw DTO, равный сохранённым primary rows и receipts при этом guard. */
  readonly snapshot: PortableProjectSnapshot;
}
