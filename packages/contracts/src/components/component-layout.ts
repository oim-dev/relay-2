import { RelayError } from "../errors/relay-error";
import type { EntityKind } from "../entities/identity.types";
import type {
  ComponentCollectionName,
  ComponentKind,
  ComponentLayout,
  ComponentSeed,
  PortableComponent,
  ComponentRecord,
} from "./component.types";
import { componentObject, isComponentValue } from "./component-shape";
import { compareComponentPositions } from "./component-position";
import { cloneComponentData } from "./component-clone";
import { componentMessages } from "./component.messages";

const fields: Readonly<Partial<Record<EntityKind, readonly ComponentCollectionName[]>>> = {
  task: ["acceptanceCriteria", "dependencies", "related", "targets"],
  "work-plan": ["stages", "scope", "participants"],
  release: ["planIds"],
  document: ["relations"],
  "work-session": ["runs"],
  project: ["documentSections", "retiredDocumentSectionIds"],
  application: ["implementationIds"],
};
const collections: Readonly<
  Record<Exclude<ComponentKind, "collection" | "address-assignment">, ComponentCollectionName>
> = {
  "task-criterion": "acceptanceCriteria",
  "task-dependency": "dependencies",
  "task-related": "related",
  "task-target": "targets",
  "plan-stage": "stages",
  "plan-task": "stages",
  "plan-scope": "scope",
  "plan-participant": "participants",
  "release-plan": "planIds",
  "document-relation": "relations",
  "session-run": "runs",
  "document-section": "documentSections",
  "section-reservation": "retiredDocumentSectionIds",
  "application-participation": "implementationIds",
};

/**
 * Возвращает владельцу его нормализуемые поля; остальные JSON-поля не переинтерпретируются.
 */
export function componentFields(kind: EntityKind): readonly ComponentCollectionName[] {
  return fields[kind] ?? [];
}

/**
 * Возвращает поле raw-агрегата, которому принадлежит часть; адрес не находится в data.
 */
export function componentCollection(
  component: PortableComponent | ComponentSeed,
): ComponentCollectionName | null {
  if (component.kind === "address-assignment") {
    return null;
  }
  if (component.kind === "collection") {
    if (!componentObject(component.value) || !isComponentValue("collection", component.value)) {
      return corruptComponent();
    }
    return component.value.field;
  }
  return collections[component.kind];
}

/**
 * Сообщает механическое повреждение без попытки восстановить отсутствующие значения.
 */
function corruptComponent(): never {
  throw new RelayError("CORRUPT_DATA", componentMessages.shape, 1);
}

/**
 * Создаёт проверенный черновик части; утверждение типа связывает проверенные kind/value.
 */
function seed(
  kind: ComponentKind,
  value: unknown,
  id: string | null,
  identity: string,
  collection: ComponentCollectionName,
  group = "",
): ComponentSeed | undefined {
  if (!isComponentValue(kind, value)) {
    return undefined;
  }
  // Проверка isComponentValue подтверждает полную техническую форму соответствующего kind.
  return {
    kind,
    value: cloneComponentData(value),
    id,
    identity,
    collection,
    group,
  } as ComponentSeed;
}

/**
 * Выделяет один элемент известной коллекции, не создавая ID и не изменяя исходный объект.
 */
function itemSeeds(field: ComponentCollectionName, item: unknown): ComponentSeed[] | undefined {
  const object = componentObject(item) ? item : undefined;
  const ownId = typeof object?.id === "string" && object.id.length > 0 ? object.id : null;
  let part: ComponentSeed | undefined;
  switch (field) {
    case "acceptanceCriteria":
      part = ownId === null ? undefined : seed("task-criterion", item, ownId, ownId, field);
      break;
    case "documentSections":
      part = ownId === null ? undefined : seed("document-section", item, ownId, ownId, field);
      break;
    case "runs":
      part = ownId === null ? undefined : seed("session-run", item, ownId, ownId, field);
      break;
    case "dependencies":
    case "related":
      part =
        typeof item === "string"
          ? seed(
              field === "dependencies" ? "task-dependency" : "task-related",
              { taskId: item },
              null,
              item,
              field,
            )
          : undefined;
      break;
    case "targets":
      part =
        typeof item === "string"
          ? seed("task-target", { targetId: item }, null, item, field)
          : undefined;
      break;
    case "participants":
      part =
        typeof item === "string"
          ? seed("plan-participant", { participant: item }, null, item, field)
          : undefined;
      break;
    case "planIds":
      part =
        typeof item === "string"
          ? seed("release-plan", { planId: item }, null, item, field)
          : undefined;
      break;
    case "implementationIds":
      part =
        typeof item === "string"
          ? seed("application-participation", { implementationId: item }, null, item, field)
          : undefined;
      break;
    case "retiredDocumentSectionIds":
      part =
        typeof item === "string"
          ? seed("section-reservation", { sectionId: item }, item, item, field)
          : undefined;
      break;
    case "scope":
      part =
        ownId === null
          ? undefined
          : seed("plan-scope", item, null, JSON.stringify([object?.kind, ownId]), field);
      break;
    case "relations": {
      const target = componentObject(object?.target) ? object.target : undefined;
      part =
        target === undefined
          ? undefined
          : seed("document-relation", item, null, JSON.stringify([target.id, object?.type]), field);
      break;
    }
    case "stages": {
      if (
        object === undefined ||
        ownId === null ||
        !Array.isArray(object.taskIds) ||
        !object.taskIds.every((id) => typeof id === "string" && id.length > 0) ||
        new Set(object.taskIds).size !== object.taskIds.length
      ) {
        return undefined;
      }
      const { taskIds, ...value } = object;
      const stage = seed("plan-stage", value, ownId, ownId, field);
      if (stage === undefined) {
        return undefined;
      }
      const memberships = taskIds.map((taskId) =>
        seed(
          "plan-task",
          { stageId: ownId, taskId },
          null,
          JSON.stringify([ownId, taskId]),
          field,
          ownId,
        ),
      );
      return [stage, ...memberships.filter((entry): entry is ComponentSeed => entry !== undefined)];
    }
  }
  return part === undefined ? undefined : [part];
}

/**
 * Разлагает только механически распознаваемые коллекции и сохраняет точные скаляры/Markdown.
 * Неверная форма остаётся в record.data и malformed; она не маскируется пустым массивом.
 * comments задачи — отдельный журнал и никогда не входят в сохраняемый owner payload.
 */
export function splitComponentRecord<T extends ComponentRecord>(
  input: Readonly<T>,
): ComponentLayout<T> {
  const record: T = cloneComponentData(input);
  if (record.kind === "task") {
    delete record.data.comments;
  }
  const seeds: ComponentSeed[] = [];
  const malformed: ComponentCollectionName[] = [];
  for (const field of componentFields(record.kind)) {
    if (!Object.hasOwn(record.data, field)) {
      continue;
    }
    const value = record.data[field];
    if (!Array.isArray(value)) {
      malformed.push(field);
      continue;
    }
    const parts = value.map((item) => itemSeeds(field, item));
    const flattened = parts.flatMap((items) => items ?? []);
    const identities = flattened.map((part) => JSON.stringify([part.kind, part.identity]));
    if (
      parts.some((items) => items === undefined) ||
      new Set(identities).size !== identities.length
    ) {
      malformed.push(field);
      continue;
    }
    const declaration = seed("collection", { field }, field, field, field);
    if (declaration === undefined) {
      return corruptComponent();
    }
    seeds.push(declaration, ...flattened);
    delete record.data[field];
  }
  return { record, seeds, malformed };
}

/**
 * Однозначно кодирует scoped идентичность части без предположений о разделителях внутри IDs.
 */
export function componentIdentity(
  component: Pick<PortableComponent, "ownerId" | "kind" | "id">,
): string {
  return JSON.stringify([component.ownerId, component.kind, component.id]);
}

/**
 * Проверяет совпадение прежнего scoped ID в primary header и native value части.
 */
export function hasConsistentComponentId(component: PortableComponent): boolean {
  switch (component.kind) {
    case "task-criterion":
    case "plan-stage":
    case "session-run":
    case "document-section":
      return component.id === component.value.id;
    case "collection":
      return component.id === component.value.field;
    case "section-reservation":
      return component.id === component.value.sectionId;
    default:
      return true;
  }
}

/**
 * Выделяет воспроизводимый ID старого назначения без собственного ID, без crypto/clock/I/O.
 * JSON-тройка сохраняет Unicode и исключает неоднозначность разделителей; для новых назначений нужен UUID.
 */
export function componentMigrationId(
  ownerId: string,
  kind: ComponentKind,
  identity: string,
): string {
  return `legacy:${JSON.stringify([ownerId, kind, identity])}`;
}

/**
 * Выделяет ID нового включения из заранее зафиксированного command/effect allocationId.
 * Retry того же плана сохраняет ID; отдельный remove/readd step имеет другой allocationId.
 */
export function componentAllocatedId(
  allocationId: string,
  ownerId: string,
  kind: ComponentKind,
  identity: string,
): string {
  return `allocated:${JSON.stringify([allocationId, ownerId, kind, identity])}`;
}

/**
 * Возвращает естественный адрес действующего элемента; readd получает новый постоянный ID.
 */
export function componentNaturalIdentity(component: PortableComponent): string {
  switch (component.kind) {
    case "document-relation": {
      const value = component.value;
      if (!isComponentValue("document-relation", value)) {
        return corruptComponent();
      }
      return JSON.stringify([value.target.id, value.type]);
    }
    case "plan-task": {
      const value = component.value;
      if (!componentObject(value)) {
        return corruptComponent();
      }
      return JSON.stringify([value.stageId, value.taskId]);
    }
    case "plan-scope": {
      const value = component.value;
      if (!componentObject(value)) {
        return corruptComponent();
      }
      return JSON.stringify([value.kind, value.id]);
    }
    case "task-dependency":
    case "task-related":
      return component.value.taskId;
    case "task-target":
      return component.value.targetId;
    case "plan-participant":
      return component.value.participant;
    case "release-plan":
      return component.value.planId;
    case "application-participation":
      return component.value.implementationId;
    case "address-assignment":
      return component.value.ref;
    default:
      return component.id;
  }
}

/**
 * Собирает raw aggregate из первичных parts выбранного владельца, без effective-проекций.
 * Пустые массивы появляются лишь по явной декларации collection. Дубли/потерянный этап — corruption.
 */
export function assembleComponentRecord<T extends ComponentRecord>(
  input: Readonly<T>,
  supplied: readonly PortableComponent[],
): T {
  const record: T = cloneComponentData(input);
  const parts = supplied
    .filter((part) => part.ownerId === record.id && !part.deleted)
    .sort(
      (a, b) =>
        compareComponentPositions(a.position, b.position) || compareComponentPositions(a.id, b.id),
    );
  const seen = new Set<string>();
  for (const part of parts) {
    const key = componentIdentity(part);
    if (
      seen.has(key) ||
      !isComponentValue(part.kind, part.value) ||
      !hasConsistentComponentId(part)
    ) {
      return corruptComponent();
    }
    seen.add(key);
  }
  for (const declaration of parts.filter((part) => part.kind === "collection")) {
    const field = declaration.value.field;
    if (!componentFields(record.kind).includes(field) || Object.hasOwn(record.data, field)) {
      return corruptComponent();
    }
    const members = parts.filter(
      (part) => part.kind !== "collection" && componentCollection(part) === field,
    );
    record.data[field] = members
      .filter((part) => part.kind !== "plan-task")
      .map((part) => {
        switch (part.kind) {
          case "task-dependency":
          case "task-related":
            return part.value.taskId;
          case "task-target":
            return part.value.targetId;
          case "plan-participant":
            return part.value.participant;
          case "release-plan":
            return part.value.planId;
          case "application-participation":
            return part.value.implementationId;
          case "section-reservation":
            return part.value.sectionId;
          case "plan-stage":
            return {
              ...part.value,
              taskIds: members
                .filter((member) => member.kind === "plan-task" && member.value.stageId === part.id)
                .map((member) =>
                  member.kind === "plan-task" ? member.value.taskId : corruptComponent(),
                ),
            };
          default:
            return cloneComponentData(part.value);
        }
      });
    if (field === "stages") {
      const stages = new Set(
        members.filter((part) => part.kind === "plan-stage").map((part) => part.id),
      );
      if (members.some((part) => part.kind === "plan-task" && !stages.has(part.value.stageId))) {
        return corruptComponent();
      }
    }
  }
  for (const part of parts) {
    const field = componentCollection(part);
    if (field !== null && !Object.hasOwn(record.data, field)) {
      return corruptComponent();
    }
  }
  return record;
}
