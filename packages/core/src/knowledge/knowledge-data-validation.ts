import { isEntitySlug, RelayError, validateActor, type EntityRecord } from "@relay/contracts";
import { KNOWLEDGE_LIMITS } from "./knowledge-constants";
import { knowledgeMessages } from "./knowledge.messages";
import { isKnowledgeTitle } from "./knowledge-title";
import type { KnowledgeInput } from "./knowledge.types";

/**
 * Примитивы проверки сохранённой формы знания с диагностикой поля исходной записи.
 * Не нормализует данные и не подставляет значения по умолчанию.
 */
export class KnowledgeDataValidation {
  /* Исходная запись для диагностик повреждённого ID, вида и поля. */
  private readonly record: EntityRecord;

  /**
   * Привязывает диагностики к записи, не изменяя её данные.
   */
  constructor(record: EntityRecord) {
    this.record = record;
  }

  /**
   * Отклоняет повреждённое поле с машинно-читаемым путём и идентичностью записи.
   */
  fail(field: string): never {
    throw new RelayError("CORRUPT_DATA", knowledgeMessages.corrupt(this.record.key, field), 1, {
      id: this.record.id,
      kind: this.record.kind,
      field,
    });
  }

  /**
   * Проверяет объект декодированного JSON; содержимое каждого поля проверяется отдельно.
   */
  object(value: unknown, field: string): KnowledgeInput {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      this.fail(field);
    }
    // Форма объекта проверена; значения его полей остаются неизвестными до декодирования.
    return value as KnowledgeInput;
  }

  /**
   * Проверяет строку без потери исходного текста и пробелов.
   */
  text(value: unknown, field: string, nonempty = false): string {
    if (typeof value !== "string" || (nonempty && !value.trim())) {
      this.fail(field);
    }
    return value;
  }

  /**
   * Проверяет непустой однострочный заголовок.
   */
  title(value: unknown, field: string): string {
    if (!isKnowledgeTitle(value)) {
      this.fail(field);
    }
    return value;
  }

  /**
   * Проверяет постоянный ID без крайних пробелов и управляющих символов.
   */
  id(value: unknown, field: string): string {
    const result = this.text(value, field, true);
    if (result !== result.trim() || /[\p{Cc}\u2028\u2029]/u.test(result)) {
      this.fail(field);
    }
    return result;
  }

  /**
   * Проверяет ограниченную грамматику постоянного ID раздела.
   */
  sectionId(value: unknown, field: string): string {
    const result = this.id(value, field);
    if (
      result.length > KNOWLEDGE_LIMITS.sectionId ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(result)
    ) {
      this.fail(field);
    }
    return result;
  }

  /**
   * Проверяет сохранённое значение предметного перечисления.
   */
  choice(value: unknown, variants: readonly string[], field: string): void {
    if (typeof value !== "string" || !variants.includes(value)) {
      this.fail(field);
    }
  }

  /**
   * Проверяет массив и верхнюю границу числа элементов без пропуска пустых ячеек.
   */
  array(value: unknown, field: string, max = Infinity): readonly unknown[] {
    if (!Array.isArray(value) || value.length > max) {
      this.fail(field);
    }
    return value;
  }

  /**
   * Проверяет уникальные постоянные ID, сохраняя исходный порядок.
   */
  identifiers(value: unknown, field: string): string[] {
    const result = Array.from(this.array(value, field), (item) => this.id(item, field));
    if (new Set(result).size !== result.length) {
      this.fail(field);
    }
    return result;
  }

  /**
   * Проверяет сохранённый slug приложения, доски или проекта.
   */
  slug(value: unknown): void {
    const result = this.text(value, "slug");
    if (!isEntitySlug(result)) {
      this.fail("slug");
    }
  }

  /**
   * Проверяет сохранённый префикс доски или приложения.
   */
  prefix(value: unknown): void {
    const result = this.text(value, "prefix");
    if (
      result.length > KNOWLEDGE_LIMITS.prefix ||
      !/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/u.test(result)
    ) {
      this.fail("prefix");
    }
  }

  /**
   * Отклоняет неизвестное поле сохранённого объекта, включая вложенные отношения.
   */
  fields(value: KnowledgeInput, allowed: readonly string[], path = "data"): void {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        this.fail(`${path}.${key}`);
      }
    }
  }

  /**
   * Проверяет общую оболочку знания и автора через единое правило Contracts.
   */
  metadata(): void {
    const record = this.record;
    this.id(record.id, "id");
    this.id(record.key, "key");
    if (/[\s:]/u.test(record.key)) {
      this.fail("key");
    }
    if (!Number.isSafeInteger(record.revision) || record.revision < 1) {
      this.fail("revision");
    }
    for (const field of ["createdAt", "updatedAt"] as const) {
      if (!Number.isFinite(Date.parse(this.text(record[field], field)))) {
        this.fail(field);
      }
    }
    for (const field of ["createdBy", "updatedBy"] as const) {
      try {
        validateActor(record[field]);
      } catch (error) {
        if (!(error instanceof RelayError)) {
          throw error;
        }
        this.fail(field);
      }
    }
  }
}
