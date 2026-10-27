import type { NamedCommand } from "@relay/contracts";
import type { ProductCommand, ProductState } from "../types/product.type";

/**
 * Переводит форму в текущие предметные действия; не читает свежие guards.
 */
export function productCommands(command: ProductCommand, source: ProductState): NamedCommand[] {
  const { fields } = command;
  if (fields.kind === "scope") return scopeCommands(command, source);
  const kind = fields.kind === "passport" ? "product" : fields.kind;
  const update = command.action === "update";
  const base = {
    op: `${kind}.${update ? "update" : "create"}`,
    ...(update
      ? { ifRevision: command.ifRevision, ...(kind === "product" ? {} : { ref: command.id }) }
      : {}),
  };
  if (fields.kind === "document")
    return [
      {
        ...base,
        input: {
          name: fields.name,
          summary: fields.summary,
          body: fields.body,
          documentKind: fields.documentKind,
          relations: fields.links.map((link) => ({
            target:
              link.kind === "product"
                ? source.records.find((record) => record.fields.kind === "passport")?.id
                : link.id,
            type: "documents",
            description: "",
          })),
        },
      },
    ];
  const input = {
    name: fields.name,
    description: fields.description,
    ...("summary" in fields ? { summary: fields.summary } : {}),
  };
  if (fields.kind === "scenario")
    return [{ ...base, input: { ...input, ...(update ? {} : { feature: fields.featureId }) } }];
  if (fields.kind === "application")
    return [
      {
        ...base,
        input: {
          ...input,
          type: fields.type,
          ...(update
            ? {}
            : { slug: fields.slug, ...(fields.prefix ? { prefix: fields.prefix } : {}) }),
        },
      },
    ];
  return [{ ...base, input }];
}

/**
 * Содержание существующих реализаций проверяется их исходным CAS; создание
 * и финальный состав — CAS приложения. Все шаги применяются одним batch.
 * Снятие участия не удаляет реализацию и не сбрасывает её статус.
 */
function scopeCommands(command: ProductCommand, source: ProductState): NamedCommand[] {
  const fields = command.fields;
  if (fields.kind !== "scope") throw new Error("Ожидался состав приложения.");
  const application = source.records.find(
    (record) => record.id === fields.applicationId && record.fields.kind === "application",
  );
  const scope = source.records.find(
    (record) =>
      record.fields.kind === "scope" && record.fields.applicationId === fields.applicationId,
  );
  if (!application || scope?.fields.kind !== "scope")
    throw new Error("Исходное приложение не найдено.");
  const commands: NamedCommand[] = [];
  for (const selected of fields.contracts) {
    const previous = scope.fields.contracts.find(
      (entry) => entry.featureId === selected.featureId && entry.scenarioId === selected.scenarioId,
    );
    const input = {
      title: selected.title,
      description: selected.description,
      status: selected.status,
    };
    if (previous) {
      if (previous.revision === undefined)
        throw new Error("У исходной реализации отсутствует ревизия.");
      commands.push({
        op: "implementation.update",
        ref: previous.id,
        ifRevision: previous.revision,
        input,
      });
    }
  }
  // Восстанавливаем прежнюю FI до создания новой SI. Содержание уже защищено
  // исходными ревизиями выше; промежуточный состав не выходит за транзакцию.
  const targets = scope.fields.contracts
    .filter(
      (previous) =>
        previous.active ||
        fields.contracts.some(
          (selected) =>
            selected.featureId === previous.featureId &&
            selected.scenarioId === previous.scenarioId,
        ),
    )
    .map((entry) => entry.scenarioId ?? entry.featureId);
  commands.push({
    op: "application.participation.replace",
    as: "restore",
    ref: application.id,
    ifRevision: application.revision,
    input: { targets },
  });
  let ownerRevision: NamedCommand["ifRevision"] = { $revision: "restore" };
  for (const selected of fields.contracts) {
    if (
      scope.fields.contracts.some(
        (entry) =>
          entry.featureId === selected.featureId && entry.scenarioId === selected.scenarioId,
      )
    )
      continue;
    const name = `implementation${commands.length}`;
    commands.push({
      op: "implementation.create",
      as: name,
      ifRevision: ownerRevision,
      input: {
        title: selected.title,
        description: selected.description,
        status: selected.status,
        application: application.id,
        target: selected.scenarioId ?? selected.featureId,
      },
    });
    ownerRevision = { $revision: name };
  }
  commands.push({
    op: "application.participation.replace",
    ref: application.id,
    ifRevision: ownerRevision,
    input: { targets: fields.contracts.map((entry) => entry.scenarioId ?? entry.featureId) },
  });
  return commands;
}
