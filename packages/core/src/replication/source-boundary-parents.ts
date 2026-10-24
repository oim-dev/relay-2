import {
  RelayError,
  type ReplicationTransition,
  type ReplicationChangeset,
  type PortableProjectSnapshot,
} from "@relay/contracts";
import { canonicalJson } from "@relay/storage";
import { replicationMessages } from "./replication.messages";

/**
 * Разрешает технический source только как полную первоначальную материализацию проекта.
 * Genesis и миграция v1/v2 не имеют переносимой before-истории: все owners/parts создаются с нуля.
 * Отсутствие named metadata само по себе не даёт полномочий; проверяются корень, sequence,
 * отсутствие причинных зависимостей и before-сторон. Остальные технические net effects без tape
 * консервативно отклоняются, даже если у них правдоподобные parents.
 * При replay previous обязателен у вызывающего и должен быть действительно пустым canonical parent.
 */
export function assertInitialReplicationSource(
  source: ReplicationChangeset,
  previous?: PortableProjectSnapshot,
): void {
  const step = source.transitions?.[0];
  const expectedCommand = source.mode === "baseline" ? "baseline" : "storage.atomic";
  if (
    source.transitions?.length !== 1 ||
    step?.command !== expectedCommand ||
    step.targets !== undefined ||
    step.timestamp !== undefined ||
    (step.predicates?.length ?? 0) !== 0 ||
    step.readContext.length !== 0 ||
    source.sequence !== 1 ||
    source.dependencies.length !== 0 ||
    source.readContext.length !== 0 ||
    !source.entities.some(
      (entry) => entry.id === source.projectId && entry.after?.record.kind === "project",
    ) ||
    source.entities.some((entry) => entry.before !== null || entry.after === null) ||
    source.components?.some((entry) => entry.before !== null)
  ) {
    throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
      path: "source.technical-initialization",
    });
  }
  if (
    previous !== undefined &&
    (previous.entities.length +
      (previous.components?.length ?? 0) +
      previous.addresses.length +
      previous.comments.length +
      previous.receipts.length +
      previous.confirmations.length !==
      0 ||
      previous.publication != null)
  ) {
    throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
      path: "source.technical-parent",
    });
  }
}

/**
 * Проверяет непосредственную причинность исходной команды либо проверенного genesis/migration,
 * не схлопнутой транзакции и не merge. Допустимость технического пути проверяется отдельно до вызова.
 * Создание не имеет предков; неизменённая сторона сохраняет версию; изменение имеет ровно before.
 * Форму сторон и их содержательные hashes вызывающий проверяет до этой функции.
 */
export function assertSourceBoundaryParents(step: ReplicationTransition): void {
  for (const { before, after } of step.entities) {
    if (after === null) {
      throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, {
        path: "source.entity.after",
      });
    }
    const unchanged =
      before !== null && canonicalJson(before.record) === canonicalJson(after.record);
    assertImmediateParents(before, after, unchanged, "source.entity.parents");
  }
  for (const { before, after } of step.components) {
    const { version: _version, parents: _parents, ...content } = after;
    let unchanged = false;
    if (before !== null) {
      const { version: _beforeVersion, parents: _beforeParents, ...previous } = before;
      unchanged = canonicalJson(previous) === canonicalJson(content);
    }
    assertImmediateParents(before, after, unchanged, "source.component.parents");
  }
}

/**
 * Отклоняет лишнего, пропущенного или выдуманного предка даже при корректно пересчитанном hash.
 */
function assertImmediateParents(
  before: { readonly version: string; readonly parents?: readonly string[] } | null,
  after: { readonly version: string; readonly parents?: readonly string[] },
  unchanged: boolean,
  path: string,
): void {
  let valid: boolean;
  if (before === null) {
    valid = after.parents?.length === 0;
  } else if (unchanged) {
    valid = after.version === before.version;
  } else {
    valid = after.parents?.length === 1 && after.parents[0] === before.version;
  }
  if (!valid) {
    throw new RelayError("REPLICATION_FORMAT", replicationMessages.format, 2, { path });
  }
}
