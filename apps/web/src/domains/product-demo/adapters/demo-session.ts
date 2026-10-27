import { z } from "zod";
import { readSessionStored, writeSessionStored } from "infra/browser-storage";
import {
  DEMO_MODE_SCHEMA,
  PRODUCT_DOCUMENT_SCHEMA,
  PRODUCT_SNAPSHOT_SCHEMA,
  PRODUCT_STATUS_SCHEMA,
} from "../config/product-demo.schema";
import { PRODUCT_DEMO_SEED } from "../config/seed";
import { CONTRIBUTION_SEEDS } from "../config/contribution-seeds";
import { DOCUMENTATION_SCHEMA } from "../config/documentation.schema";
import { DOCUMENTATION_SEEDS } from "../config/documentation-seeds";
import { createSnapshot } from "../helpers/create-snapshot";
import { getContributionTitle } from "../helpers/get-contribution-title";
import { refreshContributionDescriptions } from "../helpers/refresh-contribution-descriptions";
import type { ProductSnapshot } from "../types/product-demo.type";

const SESSION_SCHEMA = z.object({
  filled: PRODUCT_SNAPSHOT_SCHEMA.extend({
    documentation: z
      .array(DOCUMENTATION_SCHEMA)
      .default(() => structuredClone(DOCUMENTATION_SEEDS)),
  }),
  empty: PRODUCT_SNAPSHOT_SCHEMA,
  bucket: z.enum(["filled", "empty"]),
  mode: DEMO_MODE_SCHEMA,
});
/** Предыдущая версия знала участие приложения только на уровне фичи. */
const PREVIOUS_SNAPSHOT_SCHEMA = PRODUCT_SNAPSHOT_SCHEMA.extend({
  version: z.literal(2),
  contributions: z.array(
    z.object({
      featureId: z.string(),
      applicationId: z.string(),
      description: z.string(),
      status: PRODUCT_STATUS_SCHEMA,
    }),
  ),
});
/** Первый прототип задавал готовность непосредственно у фичи. */
const LEGACY_SNAPSHOT_SCHEMA = PREVIOUS_SNAPSHOT_SCHEMA.extend({
  version: z.literal(1),
  features: z.array(PRODUCT_DOCUMENT_SCHEMA.extend({ status: PRODUCT_STATUS_SCHEMA })),
});
/** Сессия с уже описанными общими сценариями. */
const PREVIOUS_SESSION_SCHEMA = SESSION_SCHEMA.extend({
  filled: PREVIOUS_SNAPSHOT_SCHEMA,
  empty: PREVIOUS_SNAPSHOT_SCHEMA,
});
/** Совместимость с уже сохранёнными описаниями и связями прототипа. */
const LEGACY_SESSION_SCHEMA = SESSION_SCHEMA.extend({
  filled: LEGACY_SNAPSHOT_SCHEMA,
  empty: LEGACY_SNAPSHOT_SCHEMA,
});
/** Изолированная сессия продукта. */
export type DemoSession = z.infer<typeof SESSION_SCHEMA>;

/**
 * Подхватывает новые описания стандартных примеров в уже открытой сессии прототипа.
 */
export const refreshDemoSession = (session: DemoSession): DemoSession => {
  const filled = refreshContributionDescriptions(session.filled);
  const empty = refreshContributionDescriptions(session.empty);
  return filled === session.filled && empty === session.empty
    ? session
    : { ...session, filled, empty };
};

/**
 * Сохраняет прежние документы и связи, дополняя известные моки описаниями участия в сценариях.
 */
const migrateSnapshot = (
  snapshot: z.infer<typeof LEGACY_SNAPSHOT_SCHEMA> | z.infer<typeof PREVIOUS_SNAPSHOT_SCHEMA>,
  isEmpty = false,
): ProductSnapshot => {
  const features = snapshot.features.map((feature) => ({
    id: feature.id,
    name: feature.name,
    summary: feature.summary,
    description: feature.description,
    scenarios:
      "scenarios" in feature
        ? feature.scenarios
        : structuredClone(
            PRODUCT_DEMO_SEED.features.find((seed) => seed.id === feature.id)?.scenarios ?? [],
          ),
  }));
  return {
    ...snapshot,
    version: 3,
    documentation: isEmpty ? [] : structuredClone(DOCUMENTATION_SEEDS),
    features,
    contributions: snapshot.contributions.map((link) => {
      const seed = CONTRIBUTION_SEEDS.find(
        (entry) => entry.applicationId === link.applicationId && entry.featureId === link.featureId,
      );
      const feature = features.find((entry) => entry.id === link.featureId);
      return {
        applicationId: link.applicationId,
        featureId: link.featureId,
        title: getContributionTitle(link.description),
        description: link.description,
        status: link.status,
        scenarios: structuredClone(
          seed?.scenarios.filter((entry) =>
            feature?.scenarios.some((scenario) => scenario.id === entry.scenarioId),
          ) ?? [],
        ),
      };
    }),
  };
};

/**
 * Восстанавливает проверенные данные конкретного проекта в этой вкладке.
 */
export const readDemoSession = (
  scopeId: string,
): { /** Данные. */ session: DemoSession; /** Состояние восстановления. */ notice: string } => {
  const stored = readSessionStored(`relay:product-prototype:v3:${scopeId}`);
  const parsed = SESSION_SCHEMA.safeParse(stored);
  if (parsed.success) {
    const session = refreshDemoSession(parsed.data);
    return {
      session,
      notice:
        session === parsed.data
          ? ""
          : "Стандартные примеры вкладов дополнены Markdown-описаниями реализации и проверок. Ваши правки сохранены.",
    };
  }
  if (stored === undefined) {
    const previous = PREVIOUS_SESSION_SCHEMA.safeParse(
      readSessionStored(`relay:product-prototype:v2:${scopeId}`),
    );
    const legacyData = previous.success
      ? previous
      : LEGACY_SESSION_SCHEMA.safeParse(readSessionStored(`relay:product-prototype:v1:${scopeId}`));
    if (legacyData.success)
      return {
        session: refreshDemoSession({
          ...legacyData.data,
          filled: migrateSnapshot(legacyData.data.filled),
          empty: migrateSnapshot(legacyData.data.empty, true),
        }),
        notice:
          "Обновлён прототип приложений: добавлены вклады в сценарии. Ваши описания, фичи и связи сохранены.",
      };
  }
  return {
    session: {
      filled: createSnapshot(),
      empty: createSnapshot(true),
      bucket: "filled",
      mode: "filled",
    },
    notice:
      stored === undefined
        ? ""
        : "Локальные данные не удалось прочитать. Восстановлен исходный пример.",
  };
};

/**
 * Записывает только локальный прототип выбранного проекта.
 */
export const writeDemoSession = (scopeId: string, session: DemoSession): boolean =>
  writeSessionStored(`relay:product-prototype:v3:${scopeId}`, session);
