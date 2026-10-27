import { z } from "zod";
import { DEMO_MODE, PRODUCT_STATUS } from "./product-demo.config";
import { getContributionTitle } from "../helpers/get-contribution-title";
import { DOCUMENTATION_SCHEMA } from "./documentation.schema";

/** Проверка готовности. */
export const PRODUCT_STATUS_SCHEMA = z.enum(PRODUCT_STATUS);
/** Проверка сценария. */
export const DEMO_MODE_SCHEMA = z.enum(DEMO_MODE);
/** Общая читаемая часть документа. */
export const PRODUCT_DOCUMENT_SCHEMA = z.object({
  id: z.string(),
  key: z.string().optional(),
  name: z.string(),
  summary: z.string(),
  description: z.string(),
});
/** Сценарий имеет постоянный ID внутри фичи и собственное описание. */
export const PRODUCT_SCENARIO_SCHEMA = z.object({
  id: z.string().min(1),
  key: z.string().optional(),
  name: z.string(),
  description: z.string(),
  status: PRODUCT_STATUS_SCHEMA.optional(),
});
/** Требование и его сценарии; отсутствие status означает отсутствие проекции Core. */
export const PRODUCT_FEATURE_SCHEMA = PRODUCT_DOCUMENT_SCHEMA.extend({
  status: PRODUCT_STATUS_SCHEMA.optional(),
  scenarios: z.array(PRODUCT_SCENARIO_SCHEMA),
});
/** Приложение отвечает за часть продукта. */
export const PRODUCT_APPLICATION_SCHEMA = PRODUCT_DOCUMENT_SCHEMA.extend({
  type: z.string(),
  slug: z.string(),
  prefix: z.string().default(""),
});
/** Часть общего сценария, которую обязуется реализовать приложение. */
export const PRODUCT_SCENARIO_CONTRIBUTION_SCHEMA = z
  .object({
    scenarioId: z.string(),
    contractId: z.string().optional(),
    key: z.string().optional(),
    title: z.string().optional(),
    description: z.string(),
    status: PRODUCT_STATUS_SCHEMA.default("none"),
  })
  .transform((entry) => ({
    ...entry,
    title: entry.title ?? getContributionTitle(entry.description),
  }));
/** Общая запись участия приложения в фиче и выбранных сценариях. */
export const PRODUCT_CONTRIBUTION_SCHEMA = z
  .object({
    contractId: z.string().optional(),
    key: z.string().optional(),
    featureId: z.string(),
    applicationId: z.string(),
    title: z.string().optional(),
    description: z.string(),
    status: PRODUCT_STATUS_SCHEMA.default("none"),
    scenarios: z.array(PRODUCT_SCENARIO_CONTRIBUTION_SCHEMA),
  })
  .transform((entry) => ({
    ...entry,
    title: entry.title ?? getContributionTitle(entry.description),
  }));
/** План, этап или задача прототипа. */
export const PRODUCT_WORK_SCHEMA = PRODUCT_DOCUMENT_SCHEMA.extend({
  kind: z.enum(["plan", "stage", "task"]),
  parentId: z.string().nullable(),
  status: z.enum(["done", "active", "planned"]),
  result: z.string(),
  featureIds: z.array(z.string()),
  applicationIds: z.array(z.string()),
});
/** Снимок локальной модели. */
export const PRODUCT_SNAPSHOT_SCHEMA = z.object({
  version: z.literal(3),
  epoch: z.string(),
  revision: z.number().int().nonnegative(),
  passport: PRODUCT_DOCUMENT_SCHEMA,
  features: z.array(PRODUCT_FEATURE_SCHEMA),
  applications: z.array(PRODUCT_APPLICATION_SCHEMA),
  contributions: z.array(PRODUCT_CONTRIBUTION_SCHEMA),
  work: z.array(PRODUCT_WORK_SCHEMA),
  documentation: z.array(DOCUMENTATION_SCHEMA).default([]),
});
