import type { NamedCommand } from "@relay/contracts";
import { knowledgeGuard } from "../helpers/knowledge-command";
import { knowledgeMessages } from "../config/knowledge.messages";
import type { KnowledgeSnapshot } from "../types/knowledge.types";
import type { KnowledgeWrite } from "../types/knowledge-write.types";

/**
 * Выбирает разрешённое содержание вида, исключая дополнительные поля объекта вызывающего.
 */
function knowledgeContent(write: KnowledgeWrite): NonNullable<NamedCommand["input"]> {
  if (write.kind === "implementation") {
    return {
      title: write.content.title,
      description: write.content.description,
      status: write.content.status,
    };
  }
  const texts = {
    name: write.content.name,
    summary: write.content.summary,
    description: write.content.description,
  };
  return { ...texts, ...(write.kind === "application" ? { type: write.content.type } : {}) };
}

/**
 * Адаптирует предметное намерение к текущей команде Core без обновления исходных guards.
 * Создание реализации проверяет приложение; изменение паспорта использует singleton.
 */
export function knowledgeCommand(write: KnowledgeWrite): NamedCommand {
  const input = knowledgeContent(write);
  if (write.action === "update") {
    if (write.source.entity.kind !== write.kind) {
      throw new Error(knowledgeMessages.wrongOwner);
    }
    return {
      op: `${write.kind}.update`,
      ...knowledgeGuard(write.source, write.kind === "product"),
      input,
    };
  }
  switch (write.kind) {
    case "feature":
      return { op: "feature.create", input };
    case "scenario":
      return { op: "scenario.create", input: { ...input, feature: write.featureId } };
    case "application":
      return {
        op: "application.create",
        input: {
          ...input,
          slug: write.slug,
          ...(write.prefix === undefined ? {} : { prefix: write.prefix }),
        },
      };
    case "implementation": {
      if (write.application.entity.kind !== "application") {
        throw new Error(knowledgeMessages.wrongOwner);
      }
      return {
        op: "implementation.create",
        ...knowledgeGuard(write.application, true),
        input: {
          ...input,
          application: write.application.entity.id,
          target: write.targetId,
        },
      };
    }
  }
}

/**
 * Переключает участника, сохраняя полный исходный состав и guards приложения.
 * Core проверяет совместимость всего состава и атомарно меняет active реализаций.
 */
export function participationCommand(
  owner: KnowledgeSnapshot,
  implementationId: string,
  active: boolean,
): NamedCommand {
  if (owner.entity.kind !== "application") {
    throw new Error(knowledgeMessages.wrongOwner);
  }
  const others = owner.entity.data.implementationIds.filter((id) => id !== implementationId);
  const targets = active ? [...others, implementationId] : others;
  return { op: "application.participation.replace", ...knowledgeGuard(owner), input: { targets } };
}
