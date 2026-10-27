import type { NamedCommand, ProjectEntity } from "@relay/contracts";
import { z } from "zod";
import {
  readEntity,
  readPage,
  pageGeneration,
  writeCommands,
  UncertainWriteError,
} from "domains/relay-data";
import { ApiError, relayClient } from "infra/tasks-api";
import { relationsMessages } from "../config/relations.messages";
import { relationAddress } from "../helpers/relation-address";
import { relationView } from "../mappers/relation-view";
import type {
  EntityRef,
  RelationOperation,
  RelationsPage,
  RelationsQuery,
  EntityContext,
  PendingRelationWrite,
} from "../types/relations.type";

export { relationAddress } from "../helpers/relation-address";

/**
 * Исходные команды и доставленный результат живут до acknowledgement активного editor.
 * Ключ содержит origin/project/ввод/исходный generation; operationKey принадлежит relay-data.
 */
const pending = new Map<string, PendingRelationWrite>();
const EDGE_ADDRESS = z.tuple([z.string().min(1), z.string(), z.string().min(1), z.string()]);

/**
 * Неопределённый исход запрещает менять ввод до явного восстановления квитанции.
 */
export function isRelationWriteUncertain(error: unknown): boolean {
  return error instanceof UncertainWriteError;
}

/**
 * Сохраняет причину ошибки SDK; отказ не становится пустым графом или сетевым fallback.
 */
export function relationError(error: unknown): Error {
  if (error instanceof ApiError && error.code === "PAGE_CHANGED") {
    return new Error(relationsMessages.changed, { cause: error });
  }
  return error instanceof Error ? error : new Error(relationsMessages.failed, { cause: error });
}

/**
 * Разрешает пользовательский адрес через Core, а не самодельный поиск ключа/алиаса.
 */
async function resolve(project: string, ref: string | EntityRef): Promise<ProjectEntity> {
  return readEntity(project, typeof ref === "string" ? ref : relationAddress(ref));
}

/**
 * Читает компактное окно текущей Core-проекции, не загружая полные карточки в Web.
 */
export async function getRelations(project: string, query: RelationsQuery): Promise<RelationsPage> {
  const generation = pageGeneration(query.version);
  const { root, profile: _profile, version: _version, ...parameters } = query;
  const { data } = await relayClient.read(project, "relationNeighborhood", {
    query: {
      ...parameters,
      ...(root === undefined ? {} : { ref: root }),
      ...(generation === undefined ? {} : { generation }),
    },
  });
  return relationView(data);
}

/**
 * Явно дочитывает полную компактную компоненту страницами одного generation.
 * Это O(P*(N+E)) metadata-чтений текущего Core и O(C) памяти Web; Markdown не передаётся.
 * Частичный набор при отказе не публикуется как complete=true.
 */
export async function getEntityContext(project: string, ref: string): Promise<EntityContext> {
  let offset: number | null = 0;
  let generation: number | undefined;
  let root: EntityRef | null = null;
  const nodes = new Map<string, EntityContext["nodes"][number]>();
  const edges = new Map<string, EntityContext["edges"][number]>();
  while (offset !== null) {
    const { data } = await relayClient.read(project, "relationNeighborhood", {
      query: {
        ref,
        component: true,
        offset,
        limit: 100,
        ...(generation === undefined ? {} : { generation }),
      },
    });
    generation ??= data.generation;
    if (generation !== data.generation) {
      throw new Error(relationsMessages.changed);
    }
    root = data.root;
    const page = relationView(data);
    for (const node of [...page.nodes, ...page.endpoints]) {
      nodes.set(node.ref.id, node);
    }
    for (const edge of page.edges) {
      edges.set(edge.id, edge);
    }
    offset = page.nextOffset;
  }
  if (root === null || generation === undefined) {
    throw new Error(relationsMessages.missingRoot);
  }
  return {
    root,
    version: String(generation),
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    complete: true,
  };
}

/**
 * Переводит доступное редактирование только в document.link/task.dependency.add/task.link.
 * Два bounded generation-барьера обрамляют адресные чтения; полный граф не перечитывается.
 * Guards берутся из первоначального generation, а не из новой карточки после конфликта.
 * Core остаётся владельцем допустимости типа цели, циклов и атомарности batch.
 */
async function prepareCommands(
  project: string,
  operations: readonly RelationOperation[],
  version: string,
): Promise<NamedCommand[]> {
  const generation = pageGeneration(version);
  await readPage(project, { kind: "project", limit: 1, generation });
  const commands: NamedCommand[] = [];
  for (const operation of operations) {
    let sourceRef: string | EntityRef;
    let targetRef: string | EntityRef;
    let type: string;
    let description = "";
    if (operation.action === "remove") {
      const [source, relation, target, slot] = EDGE_ADDRESS.parse(JSON.parse(operation.id));
      if (slot !== "") {
        throw new Error(relationsMessages.managed);
      }
      sourceRef = source;
      targetRef = target;
      type = relation;
    } else {
      sourceRef = operation.from;
      targetRef = operation.to;
      type = operation.type;
      description = operation.description;
    }
    const [from, to] = await Promise.all([
      resolve(project, sourceRef),
      resolve(project, targetRef),
    ]);
    const guard = { ref: from.id, ifRevision: from.revision };
    if (from.kind === "document" && (type === "documents" || type === "references")) {
      commands.push({
        ...guard,
        op: operation.action === "add" ? "document.link" : "document.unlink",
        input: { target: to.id, type, ...(operation.action === "add" ? { description } : {}) },
      });
    } else if (
      from.kind === "task" &&
      to.kind === "task" &&
      (type === "depends-on" || type === "related")
    ) {
      if (description.trim() !== "") {
        throw new Error(relationsMessages.taskDescription);
      }
      const actions = {
        "depends-on": { add: "task.dependency.add", remove: "task.dependency.remove" },
        related: { add: "task.link", remove: "task.unlink" },
      };
      commands.push({
        ...guard,
        op: actions[type][operation.action],
        input: { target: to.id },
      });
    } else {
      throw new Error(relationsMessages.supported);
    }
  }
  await readPage(project, { kind: "project", limit: 1, generation });
  return commands;
}

/**
 * Сохраняет предметные команды атомарно с исходными guards и стабильным operationKey.
 * После сетевой неопределённости повтор восстанавливает именно frozen batch, не новый graph.
 */
export async function saveRelations(
  project: string,
  operations: RelationOperation[],
  version: string,
): Promise<void> {
  if (operations.length !== 1) {
    throw new Error(relationsMessages.singleOperation);
  }
  const key = relationWriteKey(project, operations, version);
  let entry = pending.get(key);
  if (!entry) {
    entry = { commands: prepareCommands(project, structuredClone(operations), version) };
    pending.set(key, entry);
  }
  const current = entry;
  current.outcome ??= (async () => {
    try {
      await writeCommands(project, await current.commands);
      // Подтверждение хранится до acknowledgement: размонтированный editor не стирает новый draft.
    } catch (error) {
      current.outcome = undefined;
      if (!(error instanceof UncertainWriteError)) {
        pending.delete(key);
      }
      throw relationError(error);
    }
  })();
  return current.outcome;
}

/**
 * Ключ исходного намерения формы; operationKey и квитанцией владеет только relay-data.
 */
function relationWriteKey(
  project: string,
  operations: readonly RelationOperation[],
  version: string,
): string {
  return JSON.stringify([globalThis.location?.origin ?? "", project, version, operations]);
}

/**
 * Активный владелец формы подтверждает доставленный успех после удаления своего draft.
 */
export function acknowledgeRelations(
  project: string,
  operations: readonly RelationOperation[],
  version: string,
): void {
  pending.delete(relationWriteKey(project, operations, version));
}
