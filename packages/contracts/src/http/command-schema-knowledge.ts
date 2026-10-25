import {
  APPLICATION_TYPES,
  DOCUMENT_KINDS,
  DOCUMENT_RELATION_TYPES,
  DOCUMENT_STATUSES,
  DOCUMENT_TARGET_KINDS,
  IMPLEMENTATION_STATUSES,
  KNOWLEDGE_KINDS,
} from "../knowledge/knowledge.constants";
import {
  commandAddress as address,
  commandAlias,
  commandArray,
  commandEnum,
  commandDefaults,
  commandNonblank,
  commandNullable,
  commandObject,
  commandText as text,
  commandTitle,
} from "./command-schema-fields";
import type { CommandJsonSchema } from "./command-schema.types";

const texts = { name: commandTitle, summary: text, description: text };
const creationTexts = commandDefaults(texts, { summary: "", description: "" });
const slug: CommandJsonSchema = {
  type: "string",
  pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
};
const implementation = {
  title: commandTitle,
  description: text,
  status: commandEnum(IMPLEMENTATION_STATUSES),
};
const document = {
  name: commandTitle,
  summary: text,
  body: commandNonblank,
  documentKind: commandEnum(DOCUMENT_KINDS),
  documentStatus: commandEnum(DOCUMENT_STATUSES),
  sectionId: commandNullable(address),
  pinned: { type: "boolean" } satisfies CommandJsonSchema,
  relations: commandArray(
    commandObject(
      {
        target: {
          oneOf: [
            address,
            commandObject({ kind: commandEnum(DOCUMENT_TARGET_KINDS), id: address }, [
              "kind",
              "id",
            ]),
          ],
        },
        type: { ...commandEnum(DOCUMENT_RELATION_TYPES), default: "documents" },
        description: { ...text, default: "" },
      },
      ["target"],
    ),
  ),
  targets: commandArray(address),
};
const relationAliases: CommandJsonSchema = { not: { required: ["relations", "targets"] } };

/**
 * Формы знаний до разрешения адресов. Guards и локальные ссылки дополняются каталогом Core.
 */
export const knowledgeCommandInputs: Readonly<Record<string, CommandJsonSchema>> = {
  ...Object.fromEntries(
    KNOWLEDGE_KINDS.map((kind) => [
      `${kind}.rename`,
      commandObject({ key: commandNonblank }, ["key"]),
    ]),
  ),
  "project.update": commandObject({ name: commandNonblank, slug }, [], { minProperties: 1 }),
  "product.create": commandObject(creationTexts, ["name"]),
  "product.update": commandObject(texts, [], { minProperties: 1 }),
  "feature.create": commandObject(creationTexts, ["name"]),
  "feature.update": commandObject(texts, [], { minProperties: 1 }),
  "scenario.create": commandObject(
    { ...creationTexts, feature: address, featureId: address },
    ["name"],
    commandAlias("feature", "featureId"),
  ),
  "scenario.update": commandObject(texts, [], { minProperties: 1 }),
  "application.create": commandObject(
    {
      ...creationTexts,
      type: { ...commandEnum(APPLICATION_TYPES), default: "frontend" },
      slug,
      prefix: {
        type: "string",
        pattern: "^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$",
        description:
          "При отсутствии Core использует slug.toUpperCase(); получившийся префикс должен пройти собственные ограничения.",
      },
    },
    ["name", "slug"],
  ),
  "application.update": commandObject({ ...texts, type: commandEnum(APPLICATION_TYPES) }, [], {
    minProperties: 1,
  }),
  "implementation.create": commandObject(
    {
      ...commandDefaults(implementation, { description: "", status: "none" }),
      application: address,
      applicationId: address,
      target: address,
    },
    ["title", "target"],
    commandAlias("application", "applicationId"),
  ),
  "implementation.update": commandObject(implementation, [], { minProperties: 1 }),
  "document.create": commandObject(
    commandDefaults(document, {
      summary: "",
      documentKind: "description",
      documentStatus: "draft",
      pinned: false,
      sectionId: null,
    }),
    ["name", "body"],
    relationAliases,
  ),
  "document.update": commandObject(document, [], { minProperties: 1, ...relationAliases }),
  "application.participation.replace": commandObject({ targets: commandArray(address) }, [
    "targets",
  ]),
  "document.section.create": commandObject(
    {
      id: {
        ...address,
        description: "ID нового раздела; при отсутствии Core выделяет его самостоятельно.",
      },
      name: commandTitle,
    },
    ["name"],
  ),
  "document.section.update": commandObject({ id: address, name: commandTitle }, ["id", "name"]),
  "document.section.remove": commandObject({ id: address }, ["id"]),
  "document.section.move": commandObject(
    { id: address, before: commandNullable(address), last: { type: "boolean" } },
    ["id"],
    {
      oneOf: [
        {
          required: ["before"],
          not: { required: ["last"], properties: { last: { const: true } } },
        },
        {
          required: ["last"],
          properties: { last: { const: true } },
          not: { required: ["before"] },
        },
      ],
    },
  ),
  "document.link": commandObject(
    {
      target: address,
      type: { ...commandEnum(DOCUMENT_RELATION_TYPES), default: "documents" },
      description: text,
    },
    ["target"],
  ),
  "document.unlink": commandObject(
    { target: address, type: { ...commandEnum(DOCUMENT_RELATION_TYPES), default: "documents" } },
    ["target"],
  ),
};
