import { createHash } from "node:crypto";
import type { PortableProjectSnapshot } from "@relay/contracts";

/**
 * Прежний порядок наборов сравнивает UTF-16, не числовые значения и не locale хоста.
 */
function compareText(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/**
 * Воспроизводит прежний compact serializer layout 1 независимо от текущего writer.
 * Fixture получает JSON DTO Core, без undefined и других непереносимых значений.
 */
function legacyJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(legacyJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => compareText(a, b))
      .map(([key, item]) => `${JSON.stringify(key)}:${legacyJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Вычисляет прежнее имя файла по UTF-8 ID, без нового writer или его descriptor helpers.
 */
function filename(id: string): string {
  return createHash("sha256").update(id, "utf8").digest("hex");
}

/**
 * Воспроизводит несовместимые layout 1/2 для проверки отказа реального Git reader.
 * Сохраняет прежние wrappers и отдельные Markdown blobs; production codec не вызывается.
 * Вход — подготовленная публикация Core; результат принадлежит вызывающему тесту.
 */
export function encodeLegacyLayoutFixture(
  snapshot: PortableProjectSnapshot,
  layoutVersion: 1 | 2,
): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  /**
   * Добавляет прежний compact либо pretty JSON с одним LF.
   */
  function json(path: string, value: unknown): void {
    const compact = legacyJson(value);
    const content = layoutVersion === 1 ? compact : JSON.stringify(JSON.parse(compact), null, 2);
    files.set(path, Buffer.from(content + "\n"));
  }
  /**
   * Выносит представимые в UTF-8 тексты: layout 1 перечисляет имена, layout 2 добавляет digest.
   * Изменяет только переданную копию полей; непарные surrogate остаются в JSON.
   */
  function markdown(
    directory: string,
    value: Record<string, unknown>,
    allowed: readonly string[] = ["body", "description", "summary"],
  ): (string | { field: string; digest: string })[] {
    const fields: (string | { field: string; digest: string })[] = [];
    for (const field of allowed) {
      const text = value[field];
      if (typeof text === "string" && Buffer.from(text).toString("utf8") === text) {
        const bytes = Buffer.from(text);
        files.set(`${directory}/${field}.md`, bytes);
        fields.push(
          layoutVersion === 1
            ? field
            : { field, digest: createHash("sha256").update(bytes).digest("hex") },
        );
        delete value[field];
      }
    }
    return fields;
  }
  json("manifest.json", {
    layoutVersion,
    formatVersion: 1,
    modelVersion: 2,
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
    const directory = `entities/${filename(item.record.id)}`;
    const data = { ...item.record.data };
    const fields = markdown(directory, data);
    json(`${directory}/record.json`, {
      entity: { ...item, record: { ...item.record, data } },
      markdown: fields,
    });
  }
  for (const item of snapshot.components ?? []) {
    const directory = `components/${filename(JSON.stringify([item.ownerId, item.kind, item.id]))}`;
    const value = { ...item.value };
    const fields = markdown(directory, value);
    json(`${directory}/record.json`, { component: { ...item, value }, markdown: fields });
  }
  for (const item of snapshot.comments) {
    const directory = `comments/${filename(item.comment.id)}`;
    if (layoutVersion === 2) {
      const value = { ...item.comment };
      const fields = markdown(directory, value, ["body"]);
      json(`${directory}/record.json`, { comment: { ...item, comment: value }, markdown: fields });
      continue;
    }
    const { body, ...fields } = item.comment;
    if (Buffer.from(body).toString("utf8") === body) {
      files.set(`${directory}/body.md`, Buffer.from(body));
      json(`${directory}/record.json`, { ...item, comment: fields });
    } else {
      json(`${directory}/record.json`, item);
    }
  }
  for (const item of snapshot.receipts) {
    json(`receipts/${filename(item.operationKey)}.json`, item);
  }
  return files;
}
