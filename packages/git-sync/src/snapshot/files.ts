import { RelayError, isPortableIdentityText, type PortableProjectSnapshot } from "@relay/contracts";
import { createHash } from "node:crypto";
import type { GitFiles } from "../transport/repository.types";
import { address, comment, entity, receipt } from "./records";
import { array, prettyJson, invalidSnapshot, keys, object, parseJson, text } from "./json";
import { extractMarkdown, readMarkdown, restoreMarkdown } from "./markdown";
import { snapshotMessages } from "./snapshot.messages";

/**
 * Сортирует технические наборы по UTF-16 code units, независимо от locale/ICU хоста.
 */
function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/**
 * Кодирует произвольный постоянный ID в безопасное имя без коллизий регистра и reserved names.
 */
function filename(id: string): string {
  if (!id || !isPortableIdentityText(id)) {
    return invalidSnapshot();
  }
  return createHash("sha256").update(Buffer.from(id, "utf8")).digest("hex");
}

/**
 * Идентичность части scoped: JSON tuple ownerId/kind/id хешируется UTF-8 без Unicode-нормализации.
 */
function componentFilename(ownerId: string, kind: string, id: string): string {
  if (![ownerId, kind, id].every((value) => value.length > 0 && isPortableIdentityText(value))) {
    invalidSnapshot();
  }
  return filename(JSON.stringify([ownerId, kind, id]));
}

/**
 * Кодирует layout 2: pretty JSON, отдельные карточки по ID и точные Markdown-байты с digest.
 * История операций не размножается по каталогам реплик; acknowledgements остаются компактными.
 */
export function encodeSnapshot(snapshot: PortableProjectSnapshot): Map<string, Uint8Array> {
  if (
    snapshot.formatVersion !== 1 ||
    snapshot.modelVersion !== 2 ||
    snapshot.components === undefined ||
    snapshot.publication === undefined
  ) {
    throw new RelayError("GIT_FORMAT_INCOMPATIBLE", snapshotMessages.version, 4);
  }
  const files = new Map<string, Uint8Array>();
  /**
   * Добавляет однозначное JSON-представление без платформенной нормализации строк.
   */
  function json(path: string, value: unknown): void {
    if (files.has(path)) {
      invalidSnapshot();
    }
    files.set(path, Buffer.from(prettyJson(value), "utf8"));
  }
  json("manifest.json", {
    layoutVersion: 2,
    formatVersion: snapshot.formatVersion,
    modelVersion: snapshot.modelVersion,
    projectId: snapshot.projectId,
  });
  json(
    "addresses.json",
    [...snapshot.addresses].sort((a, b) => compareText(a.ref, b.ref)),
  );
  json(
    "confirmations.json",
    [...snapshot.confirmations].sort((a, b) => compareText(a.replicaId, b.replicaId)),
  );
  json("publication.json", snapshot.publication);
  for (const item of snapshot.entities) {
    if (Object.hasOwn(item.record, "revision")) {
      invalidSnapshot();
    }
    const id = filename(item.record.id);
    const data = { ...item.record.data };
    const markdown = extractMarkdown(files, `entities/${id}`, data);
    json(`entities/${id}/record.json`, {
      entity: { ...item, record: { ...item.record, data } },
      markdown,
    });
  }
  for (const component of snapshot.components) {
    const id = componentFilename(component.ownerId, component.kind, component.id);
    const value: Record<string, unknown> = { ...component.value };
    const markdown = extractMarkdown(files, `components/${id}`, value);
    json(`components/${id}/record.json`, { component: { ...component, value }, markdown });
  }
  for (const item of snapshot.comments) {
    const id = filename(item.comment.id);
    const value = { ...item.comment };
    const markdown = extractMarkdown(files, `comments/${id}`, value, ["body"]);
    json(`comments/${id}/record.json`, { comment: { ...item, comment: value }, markdown });
  }
  for (const item of snapshot.receipts) {
    json(`receipts/${filename(item.operationKey)}.json`, item);
  }
  return files;
}

/**
 * Строго читает layout 1 либо 2 без доступа к filesystem; каждый файл потребляется один раз.
 * Неизвестные пути, лишние поля, несовместимая версия и неверный project ID дают отказ до Core.
 * Оба layout возвращают только непроверенный DTO: publication/history по-прежнему проверяет Core.
 */
export function decodeSnapshotData(files: GitFiles, expectedProjectId?: string): unknown {
  const remaining = new Map(files);
  /**
   * Извлекает обязательный файл и исключает возможность повторного обращения к одному пути.
   */
  function take(path: string): Uint8Array {
    const value = remaining.get(path);
    if (!value) {
      return invalidSnapshot();
    }
    remaining.delete(path);
    return value;
  }
  const manifest = object(parseJson(take("manifest.json")));
  if (
    (manifest.layoutVersion !== 1 && manifest.layoutVersion !== 2) ||
    manifest.formatVersion !== 1 ||
    manifest.modelVersion !== 2
  ) {
    throw new RelayError("GIT_FORMAT_INCOMPATIBLE", snapshotMessages.version, 4);
  }
  keys(manifest, ["layoutVersion", "formatVersion", "modelVersion", "projectId"]);
  const projectId = text(manifest.projectId);
  if (expectedProjectId !== undefined && expectedProjectId !== projectId) {
    throw new RelayError("GIT_PROJECT_MISMATCH", snapshotMessages.project, 4);
  }
  const addresses = array(parseJson(take("addresses.json"))).map(address);
  const confirmations = array(parseJson(take("confirmations.json")));
  const publication = parseJson(take("publication.json"));
  const entities = [];
  const components = [];
  const comments = [];
  const receipts = [];
  for (const path of [...remaining.keys()].sort()) {
    if (/^entities\/[a-f0-9]+\/record\.json$/.test(path)) {
      const wrapper = object(parseJson(take(path)));
      keys(wrapper, ["entity", "markdown"]);
      const candidate = object(wrapper.entity);
      const record = object(candidate.record);
      const data = object(record.data);
      restoreMarkdown(
        remaining,
        path.slice(0, -"/record.json".length),
        data,
        wrapper.markdown,
        manifest.layoutVersion,
      );
      const item = entity(candidate);
      if (path !== `entities/${filename(item.record.id)}/record.json`) {
        invalidSnapshot();
      }
      entities.push(item);
    } else if (/^components\/[a-f0-9]+\/record\.json$/.test(path)) {
      const wrapper = object(parseJson(take(path)));
      keys(wrapper, ["component", "markdown"]);
      const component = object(wrapper.component);
      keys(component, [
        "ownerId",
        "kind",
        "id",
        "position",
        "version",
        "parents",
        "deleted",
        "value",
      ]);
      const value = object(component.value);
      restoreMarkdown(
        remaining,
        path.slice(0, -"/record.json".length),
        value,
        wrapper.markdown,
        manifest.layoutVersion,
      );
      const id = componentFilename(
        text(component.ownerId),
        text(component.kind),
        text(component.id),
      );
      if (path !== `components/${id}/record.json`) {
        invalidSnapshot();
      }
      components.push(component);
    } else if (/^comments\/[a-f0-9]+\/record\.json$/.test(path)) {
      const wrapper = object(parseJson(take(path)));
      const candidate = manifest.layoutVersion === 1 ? wrapper : object(wrapper.comment);
      const record = object(candidate.comment);
      if (manifest.layoutVersion === 1) {
        if (!Object.hasOwn(record, "body")) {
          record.body = readMarkdown(remaining, path.replace("record.json", "body.md"), null);
        }
      } else {
        keys(wrapper, ["comment", "markdown"]);
        restoreMarkdown(
          remaining,
          path.slice(0, -"/record.json".length),
          record,
          wrapper.markdown,
          manifest.layoutVersion,
          ["body"],
        );
      }
      const item = comment(candidate);
      if (path !== `comments/${filename(item.comment.id)}/record.json`) {
        invalidSnapshot();
      }
      comments.push(item);
    } else if (/^receipts\/[a-f0-9]+\.json$/.test(path)) {
      const item = receipt(parseJson(take(path)));
      if (path !== `receipts/${filename(item.operationKey)}.json`) {
        invalidSnapshot();
      }
      receipts.push(item);
    }
  }
  if (remaining.size > 0) {
    invalidSnapshot();
  }
  return {
    formatVersion: 1,
    modelVersion: 2,
    projectId,
    entities,
    components,
    addresses,
    comments,
    receipts,
    confirmations,
    publication,
  };
}
