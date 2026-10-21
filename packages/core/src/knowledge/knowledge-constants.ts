/**
 * Ограничения формы знаний, общие для входа и декодирования сохранённых данных.
 */
export const KNOWLEDGE_LIMITS = {
  prefix: 32,
  sectionId: 64,
  sections: 100,
  relations: 100,
} as const;

export const KNOWLEDGE_TEXT_FIELDS = ["name", "summary", "description"] as const;

export const DOCUMENT_SECTION_ACTIONS = ["create", "update", "move", "remove"] as const;

export const KNOWLEDGE_WRITABLE_FIELDS = {
  project: ["name", "slug"],
  product: KNOWLEDGE_TEXT_FIELDS,
  feature: KNOWLEDGE_TEXT_FIELDS,
  scenario: KNOWLEDGE_TEXT_FIELDS,
  application: [...KNOWLEDGE_TEXT_FIELDS, "type"],
  implementation: ["title", "description", "status"],
  document: [
    "name",
    "summary",
    "body",
    "documentKind",
    "documentStatus",
    "sectionId",
    "pinned",
    "relations",
    "targets",
  ],
  board: [],
} as const;
