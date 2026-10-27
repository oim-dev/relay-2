import { z } from "zod";
import { DOCUMENT_KINDS, IMPLEMENTATION_STATUSES, isEntitySlug } from "@relay/contracts";

/** Проверяемая граница постоянного продукта; Markdown остаётся строкой. */
export const PRODUCT_STATUS_SCHEMA = z.enum(IMPLEMENTATION_STATUSES);
export const PRODUCT_TARGET_LINK_SCHEMA = z.object({
  kind: z.enum(["feature", "scenario", "implementation"]),
  id: z.string(),
});
export const PRODUCT_LINK_SCHEMA = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("product") }),
  z.object({ kind: z.literal("feature"), id: z.string() }),
  z.object({ kind: z.literal("scenario"), id: z.string() }),
  z.object({ kind: z.literal("application"), id: z.string() }),
  z.object({ kind: z.literal("implementation"), applicationId: z.string(), id: z.string() }),
]);
const description = { name: z.string(), summary: z.string(), description: z.string() };
/** Постоянный адрес приложения и его доски. */
export const APPLICATION_SLUG_SCHEMA = z.string().refine(isEntitySlug);
export const PRODUCT_CONTRACT_SCHEMA = z.object({
  id: z.string(),
  key: z.string().optional(),
  revision: z.number().optional(),
  featureId: z.string(),
  scenarioId: z.string().nullable(),
  title: z.string(),
  description: z.string(),
  status: PRODUCT_STATUS_SCHEMA,
  active: z.boolean(),
});
export const PRODUCT_FIELDS_SCHEMA = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("passport"), ...description }),
  z.object({ kind: z.literal("feature"), ...description }),
  z.object({
    kind: z.literal("scenario"),
    featureId: z.string(),
    name: z.string(),
    description: z.string(),
  }),
  z.object({
    kind: z.literal("application"),
    ...description,
    slug: APPLICATION_SLUG_SCHEMA,
    prefix: z.string().optional(),
    type: z.enum(["frontend", "backend", "internal"]),
  }),
  z.object({
    kind: z.literal("scope"),
    applicationId: z.string(),
    contracts: z.array(PRODUCT_CONTRACT_SCHEMA),
  }),
  z.object({
    kind: z.literal("document"),
    name: z.string(),
    summary: z.string(),
    body: z.string(),
    documentKind: z.enum(DOCUMENT_KINDS),
    links: z.array(PRODUCT_LINK_SCHEMA),
  }),
]);
export const PRODUCT_STATE_SCHEMA = z.object({
  productId: z.string(),
  version: z.string(),
  records: z.array(
    z.object({
      id: z.string(),
      key: z.string().optional(),
      revision: z.number(),
      fields: PRODUCT_FIELDS_SCHEMA,
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
  ),
});

/** Компактная цель: список не содержит полных описаний и истории. */
export const PRODUCT_ENTITY_SUMMARY_SCHEMA = z.object({
  id: z.string(),
  key: z.string().optional(),
  kind: z.enum(["passport", "feature", "scenario", "application", "implementation", "document"]),
  title: z.string(),
  summary: z.string(),
  revision: z.number(),
  applicationId: z.string().nullable(),
  applicationKey: z.string().nullable(),
  applicationName: z.string().nullable(),
  featureId: z.string().nullable(),
  scenarioId: z.string().nullable(),
  targetKey: z.string().nullable(),
  targetName: z.string().nullable(),
  active: z.boolean(),
  status: PRODUCT_STATUS_SCHEMA.nullable(),
});
export const PRODUCT_ENTITIES_SCHEMA = z.object({
  items: z.array(PRODUCT_ENTITY_SUMMARY_SCHEMA),
  total: z.number(),
  nextOffset: z.number().nullable(),
  version: z.string(),
});
export const PRODUCT_ENTITY_SCHEMA = z.object({
  id: z.string(),
  key: z.string().optional(),
  canonicalRef: z.string().optional(),
  revision: z.number(),
  updatedAt: z.string(),
  fields: z.union([
    PRODUCT_FIELDS_SCHEMA,
    PRODUCT_CONTRACT_SCHEMA.omit({ id: true, key: true, revision: true }).extend({
      kind: z.literal("implementation"),
      applicationId: z.string(),
    }),
  ]),
});
