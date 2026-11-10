import { RelayError, type PortableProjectSnapshot } from "@relay/contracts";
import { canonicalJson } from "../snapshot/json";
import { transportMessages } from "../transport/transport.messages";
import type { GitHistoryEntry } from "../transport/repository.types";
import type {
  PublicationReadOptions,
  PublicationRepository,
  PublicationRules,
} from "./publication-reader.types";

const HEADS_PER_PAGE = 64;
const DECODED_BATCH_BYTES = 32 * 1024 * 1024;

/**
 * Привязывает Core envelope к фактическому непосредственному Git parent.
 * Opaque IDs/digests уже проверены decoder; семантику каждого transition далее проверяет Core chain.
 */
function requireImmediateParent(
  parent: PortableProjectSnapshot | null,
  child: PortableProjectSnapshot,
): void {
  const publication = child.publication;
  if (!publication) {
    throw new RelayError("GIT_PUBLICATION_REQUIRED", transportMessages.publicationRequired, 4);
  }
  if (parent === null) {
    if (publication.parent !== null) {
      throw new RelayError("GIT_PUBLICATION_REQUIRED", transportMessages.publicationRequired, 4);
    }
    return;
  }
  if (
    !parent.publication ||
    !publication.parent ||
    publication.parent.publicationId !== parent.publication.publicationId ||
    publication.parent.snapshotDigest !== parent.publication.snapshotDigest
  ) {
    throw new RelayError("GIT_PUBLICATION_REQUIRED", transportMessages.publicationRequired, 4);
  }
}

/**
 * Сравнивает полный переносимый state, включая старые confirmation bindings, без дублирования digest Core.
 */
function sameSnapshot(left: PortableProjectSnapshot, right: PortableProjectSnapshot): boolean {
  if (left === right) {
    return true;
  }
  if (
    left.projectId !== right.projectId ||
    left.publication?.publicationId !== right.publication?.publicationId
  ) {
    return false;
  }
  // Оба DTO канонизированы Core; сравниваем весь материал, включая proofs, без Git layout/hash-path работы.
  return canonicalJson(left) === canonicalJson(right);
}

/**
 * Разделяет только read-only batch при превышении byte budget, не скрывая другие отказы.
 * Крупные публикации не требуют загрузки всей истории в память.
 */
async function* filePages(
  repository: PublicationRepository,
  heads: readonly string[],
): AsyncGenerator<Map<string, Map<string, Uint8Array>>> {
  const first = heads[0];
  if (first === undefined) {
    return;
  }
  let files: Map<string, Map<string, Uint8Array>>;
  try {
    files =
      heads.length === 1
        ? new Map([[first, await repository.files(first)]])
        : await repository.filesMany(heads);
  } catch (error) {
    if (!(error instanceof RelayError && error.code === "GIT_OUTPUT_LIMIT" && heads.length > 1)) {
      throw error;
    }
    const middle = Math.ceil(heads.length / 2);
    yield* filePages(repository, heads.slice(0, middle));
    yield* filePages(repository, heads.slice(middle));
    return;
  }
  yield files;
}

/**
 * Проверяет каждый непосредственный Git-parent и каждую публикацию через Core без пропусков.
 * Cursor может отстать после crash между SQL accept и update-ref: тогда точный Core base ищется с genesis.
 * Pure refresh/restore не меняют Core. Consume принимает проверенные batches при долгом offline.
 */
export async function readPublicationHistory(
  repository: PublicationRepository,
  head: string,
  rules: PublicationRules,
  options: PublicationReadOptions,
): Promise<PortableProjectSnapshot> {
  let anchor: string | null = null;
  let previous: PortableProjectSnapshot | null = null;
  const cursor = await repository.acceptedCommit();
  if (cursor && options.base) {
    const candidate =
      options.cache?.get(cursor) ?? rules.decode(await repository.files(cursor), options.projectId);
    if (sameSnapshot(candidate, options.base)) {
      anchor = cursor;
      previous = candidate;
    }
  }
  if (anchor === head && previous) {
    return previous;
  }
  const history = await repository.history(head, anchor);
  let baseFound = options.base === null || anchor !== null;
  let validationBase = previous;
  let validationChain: PortableProjectSnapshot[] = [];
  let chain: PortableProjectSnapshot[] = [];
  let chainBytes = 0;
  let lastEntry: GitHistoryEntry | null = null;
  /**
   * Проверяет всю пачку единственным Core вызовом, сохраняя все промежуточные snapshots.
   * Затем consumer принимает часть после локального base; пропущенная из-за crash история тоже проверена.
   */
  async function consume(): Promise<void> {
    const validated = validationChain.at(-1);
    let proof: ReturnType<PublicationRules["validate"]> | undefined;
    if (validated) {
      proof = rules.validate(validationBase, validated, { chain: validationChain });
      validationBase = proof.snapshot;
    }
    const snapshot = chain.at(-1);
    if (snapshot && proof && lastEntry && options.consume) {
      await options.consume({ head: lastEntry.head, snapshot: proof.snapshot, chain, proof });
    }
    chain = [];
    validationChain = [];
    chainBytes = 0;
  }
  for (let offset = 0; offset < history.length; offset += HEADS_PER_PAGE) {
    const entries = history.slice(offset, offset + HEADS_PER_PAGE);
    const byHead = new Map(entries.map((entry) => [entry.head, entry]));
    for await (const files of filePages(
      repository,
      entries.map((entry) => entry.head),
    )) {
      for (const [commit, tree] of files) {
        const entry = byHead.get(commit);
        if (!entry) {
          throw new RelayError("GIT_UNRELATED_HISTORY", transportMessages.unrelated, 4);
        }
        const snapshot = options.cache?.get(commit) ?? rules.decode(tree, options.projectId);
        if (!snapshot.publication || (entry.parent === null) !== (previous === null)) {
          throw new RelayError(
            "GIT_PUBLICATION_REQUIRED",
            transportMessages.publicationRequired,
            4,
            { commit },
          );
        }
        // Не даём Core base-slicing скрыть Git commit с повторно вставленным старым publicationId.
        requireImmediateParent(previous, snapshot);
        const bytes = [...tree.values()].reduce((total, value) => total + value.byteLength, 0);
        if (validationChain.length > 0 && chainBytes + bytes > DECODED_BATCH_BYTES) {
          await consume();
        }
        validationChain.push(snapshot);
        chainBytes += bytes;
        previous = snapshot;
        lastEntry = entry;
        if (!baseFound) {
          if (options.base && sameSnapshot(snapshot, options.base)) {
            baseFound = true;
          }
          if (chainBytes >= DECODED_BATCH_BYTES) {
            await consume();
          }
          continue;
        }
        if (options.consume) {
          chain.push(snapshot);
        }
        if (chainBytes >= DECODED_BATCH_BYTES) {
          await consume();
        }
      }
    }
    await consume();
  }
  if (!baseFound || !validationBase) {
    throw new RelayError("GIT_BASE_NOT_FOUND", transportMessages.baseMissing, 4, { head });
  }
  return validationBase;
}
