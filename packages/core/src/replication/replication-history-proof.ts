import { RelayError, type PortableProjectSnapshot } from "@relay/contracts";
import { replicationSnapshotKey } from "./snapshot-decoder";
import { replicationMessages } from "./replication.messages";

const ANCESTOR_CACHE_LIMIT = 256;
const issued = new WeakMap<ValidatedReplicationHistory, ReadonlySet<string>>();
const known = new WeakMap<PortableProjectSnapshot, ReadonlySet<string>>();

/**
 * Непереносимая capability Core. Оболочка сама не выдаёт доверие: authority хранится в private WeakMap.
 */
export class ValidatedReplicationHistory {
  /* Точная транзитивно immutable цель проверенного пути; вне JSON-протокола. */
  readonly #target: PortableProjectSnapshot;

  /**
   * Создаёт неизменяемую оболочку, которая становится capability только после регистрации проверенного пути.
   */
  constructor(snapshot: PortableProjectSnapshot) {
    this.#target = snapshot;
    Object.freeze(this);
  }

  /**
   * Возвращает точный immutable target для prepare/accept вместе с этим token.
   */
  get snapshot(): PortableProjectSnapshot {
    return this.#target;
  }
}

/**
 * Возвращает точный ключ принятой основы; genesis имеет отдельную область projectId.
 */
function baseKey(base: PortableProjectSnapshot | null, projectId: string): string {
  return base === null ? `genesis:${projectId}` : replicationSnapshotKey(base);
}

/**
 * Отличает token от portable chain input; само instanceof не означает выданное доверие.
 */
export function isValidatedReplicationHistory(
  value: unknown,
): value is ValidatedReplicationHistory {
  return value instanceof ValidatedReplicationHistory;
}

/**
 * Проверяет authority, exact immutable target и реальную загруженную основу SQLite.
 */
export function consumeReplicationHistory(
  proof: ValidatedReplicationHistory,
  base: PortableProjectSnapshot | null,
  remote: PortableProjectSnapshot,
): void {
  const ancestors = issued.get(proof);
  if (
    ancestors === undefined ||
    proof.snapshot !== remote ||
    !ancestors.has(baseKey(base, remote.projectId))
  ) {
    throw new RelayError(
      "REPLICATION_PUBLICATION_REQUIRED",
      replicationMessages.publicationRequired,
      4,
    );
  }
}

/**
 * Проверяет наличие ранее доказанного пути до того же immutable target, без caller trusted flags.
 */
export function hasVerifiedReplicationHistory(
  base: PortableProjectSnapshot | null,
  remote: PortableProjectSnapshot,
): boolean {
  return known.get(remote)?.has(baseKey(base, remote.projectId)) ?? false;
}

/**
 * Регистрирует только действительно проверенный suffix. Непроверенный input prefix не входит в authority.
 * Ограниченные ancestor keys позволяют transitive reuse validate-each без вечного журнала в памяти.
 */
export function rememberReplicationHistory(
  base: PortableProjectSnapshot | null,
  remote: PortableProjectSnapshot,
  checked: readonly PortableProjectSnapshot[],
): ValidatedReplicationHistory {
  const origin = baseKey(base, remote.projectId);
  const inherited = base === null ? [] : [...(known.get(base) ?? [])];
  const ancestors = new Set([
    ...(known.get(remote) ?? []),
    ...inherited,
    origin,
    ...checked.map(replicationSnapshotKey),
    replicationSnapshotKey(remote),
  ]);
  const target = replicationSnapshotKey(remote);
  for (const key of ancestors) {
    if (ancestors.size <= ANCESTOR_CACHE_LIMIT) {
      break;
    }
    if (key !== origin && key !== target) {
      ancestors.delete(key);
    }
  }
  known.set(remote, ancestors);
  const proof = new ValidatedReplicationHistory(remote);
  issued.set(proof, ancestors);
  return proof;
}
