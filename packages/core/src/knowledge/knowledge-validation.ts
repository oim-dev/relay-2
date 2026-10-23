import {
  KNOWLEDGE_KINDS,
  isEntitySlug,
  isProjectName,
  RelayError,
  validateActor,
  type KnowledgeKind,
  type WriteOptions,
} from "@relay/contracts";
import { KNOWLEDGE_LIMITS } from "./knowledge-constants";
import { knowledgeMessages } from "./knowledge.messages";
import { isKnowledgeTitle } from "./knowledge-title";
import type { KnowledgeInput } from "./knowledge.types";

/**
 * Завершает разбор внешнего ввода предметной ошибкой без записи.
 */
export function invalidKnowledge(message: string): never {
  throw new RelayError("INVALID_ARGUMENT", message, 2);
}

/**
 * Проверяет простой объект внешнего ввода без преобразования значений.
 */
export function knowledgeObject(
  value: unknown,
  label: string = knowledgeMessages.inputLabel,
): KnowledgeInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalidKnowledge(knowledgeMessages.object(label));
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalidKnowledge(knowledgeMessages.plainObject(label));
  }
  // После проверки обычного объекта его значения всё ещё неизвестны и требуют разбора.
  return value as KnowledgeInput;
}

/**
 * Отклоняет лишние поля до предметного разбора разрешённого содержания.
 */
export function knowledgeFields(
  value: unknown,
  allowed: readonly string[],
  label: string = knowledgeMessages.inputLabel,
): KnowledgeInput {
  const input = knowledgeObject(value, label);
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      invalidKnowledge(knowledgeMessages.field(label, key));
    }
  }
  return input;
}

/**
 * Проверяет строку, сохраняя пробелы и полный текст; nonempty запрещает пустой смысл.
 */
export function knowledgeText(value: unknown, label: string, nonempty = false): string {
  if (typeof value !== "string" || (nonempty && !value.trim())) {
    invalidKnowledge(knowledgeMessages.text(label, nonempty));
  }
  return value;
}

/**
 * Проверяет непустое однострочное название без нормализации пробелов.
 */
export function knowledgeName(value: unknown, label = "name"): string {
  const result = knowledgeText(value, label, true);
  if (!isKnowledgeTitle(result)) {
    invalidKnowledge(knowledgeMessages.name(label));
  }
  return result;
}

/**
 * Нормализует имя проекта по правилам его локального паспорта.
 */
export function knowledgeProjectName(value: unknown): string {
  const result = knowledgeText(value, "name", true).trim();
  if (!isProjectName(result)) {
    invalidKnowledge(knowledgeMessages.projectName);
  }
  return result;
}

/**
 * Выбирает значение из предметного перечисления без утверждения типа входа.
 */
export function knowledgeChoice<T extends string>(
  value: unknown,
  variants: readonly T[],
  label: string,
): T {
  const selected = variants.find((variant) => variant === value);
  if (selected === undefined) {
    invalidKnowledge(knowledgeMessages.choice(label, variants));
  }
  return selected;
}

/**
 * Проверяет логическое значение без приведения строк к boolean.
 */
export function knowledgeBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    invalidKnowledge(knowledgeMessages.boolean(label));
  }
  return value;
}

/**
 * Проверяет неизменяемый адрес приложения или slug проекта.
 */
export function knowledgeSlug(value: unknown): string {
  const result = knowledgeText(value, "slug", true);
  if (!isEntitySlug(result)) {
    invalidKnowledge(knowledgeMessages.slug);
  }
  return result;
}

/**
 * Проверяет префикс доски и будущих реализаций приложения.
 */
export function knowledgePrefix(value: unknown): string {
  const result = knowledgeText(value, "prefix", true);
  if (result.length > KNOWLEDGE_LIMITS.prefix || !/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/u.test(result)) {
    invalidKnowledge(knowledgeMessages.prefix);
  }
  return result;
}

/**
 * Выбирает одно из альтернативных полей; одновременное присутствие запрещено.
 */
export function knowledgeAlias(input: KnowledgeInput, first: string, second: string): unknown {
  if (Object.hasOwn(input, first) && Object.hasOwn(input, second)) {
    invalidKnowledge(knowledgeMessages.alias(first, second));
  }
  return Object.hasOwn(input, first) ? input[first] : input[second];
}

/**
 * Ограничивает публичный общий EntityKind областью знаний.
 */
export function knowledgeKind(value: unknown): KnowledgeKind {
  return knowledgeChoice(value, KNOWLEDGE_KINDS, "kind");
}

/**
 * Проверяет автора, положительную ревизию и форму параметров до чтения владельца.
 */
export function validateKnowledgeWrite(value: WriteOptions, extra: readonly string[] = []): void {
  knowledgeFields(value, ["actor", "ifRevision", ...extra], knowledgeMessages.writeLabel);
  validateActor(value.actor);
  if (!Number.isSafeInteger(value.ifRevision) || value.ifRevision < 1) {
    invalidKnowledge(knowledgeMessages.revisionRequired);
  }
}
