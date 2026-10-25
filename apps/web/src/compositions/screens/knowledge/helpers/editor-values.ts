import {
  isCatalogEntity,
  type KnowledgeSnapshot,
  type CatalogKind,
  type KnowledgeWrite,
} from "domains/knowledge";
import type { KnowledgeEditorDraft, KnowledgeValues } from "../types/editor.types";
import { messages } from "../config/knowledge-screen.messages";

/**
 * Один ключ связывает черновик формы с выбранным владельцем новой реализации.
 */
export function knowledgeEditorScope(
  kind: CatalogKind,
  source: KnowledgeSnapshot | null,
  ownerId: string | null,
): string {
  return `knowledge-editor:${source?.entity.id ?? `${kind}:new:${ownerId ?? ""}`}`;
}

/**
 * Подготавливает ввод из карточки без копирования серверных связей в поля update.
 */
export function knowledgeValues(snapshot: KnowledgeSnapshot | null): KnowledgeValues {
  const empty: KnowledgeValues = {
    name: "",
    summary: "",
    description: "",
    slug: "",
    prefix: "",
    type: "frontend",
    status: "none",
    feature: null,
    target: null,
    targetKind: "feature",
  };
  const entity = snapshot?.entity;
  if (entity === undefined || !isCatalogEntity(entity)) {
    return empty;
  }
  if (entity.kind === "implementation") {
    return {
      ...empty,
      name: entity.data.title,
      description: entity.data.description,
      status: entity.data.status,
      target: entity.data.targetId,
      targetKind: entity.data.targetKind,
    };
  }
  return {
    ...empty,
    name: entity.data.name ?? "",
    summary: entity.data.summary ?? "",
    description: entity.data.description ?? "",
    ...(entity.kind === "scenario" ? { feature: entity.data.featureId } : {}),
    ...(entity.kind === "application"
      ? { slug: entity.data.slug, prefix: entity.data.prefix, type: entity.data.type }
      : {}),
  };
}

/**
 * Преобразует валидированный ввод формы в предметное намерение домена.
 * Служебный выбор каталога и незадействованные поля формы в намерение не включаются.
 */
export function knowledgeWrite(
  draft: KnowledgeEditorDraft,
  values: KnowledgeValues,
): KnowledgeWrite {
  const { kind, source, owner } = draft;
  const texts = { name: values.name, summary: values.summary, description: values.description };
  if (kind === "implementation") {
    const content = { title: values.name, description: values.description, status: values.status };
    if (source !== null) {
      return { action: "update", kind, source, content };
    }
    if (owner === null || owner.entity.kind !== "application" || values.target === null) {
      throw new Error(messages.missingImplementationContext);
    }
    return {
      action: "create",
      kind,
      content,
      application: owner,
      targetId: values.target,
    };
  }
  if (kind === "application") {
    const content = { ...texts, type: values.type };
    if (source !== null) {
      return { action: "update", kind, source, content };
    }
    return {
      action: "create",
      kind,
      content,
      slug: values.slug,
      ...(values.prefix === "" ? {} : { prefix: values.prefix }),
    };
  }
  if (source !== null) {
    return { action: "update", kind, source, content: texts };
  }
  if (kind === "feature") {
    return { action: "create", kind, content: texts };
  }
  if (kind === "scenario" && values.feature !== null) {
    return { action: "create", kind, content: texts, featureId: values.feature };
  }
  throw new Error(messages.required);
}
