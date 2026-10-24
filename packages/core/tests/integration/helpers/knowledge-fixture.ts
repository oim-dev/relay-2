import type { EntityRecord } from "@relay/contracts";
import type { ProjectDatabase } from "@relay/storage";
import { KnowledgeService } from "../../../src/knowledge/knowledge";
import { entityWriteOptions, withEntityDatabase } from "./entity-fixture";
import type { KnowledgeParticipation, KnowledgeRequirements } from "./knowledge-fixture.types";

/**
 * Передаёт тесту сервис знаний и отдельную файловую SQLite со штатными seed-записями.
 * Callback не владеет БД: withEntityDatabase ожидает Promise до закрытия и очистки.
 */
export async function withKnowledgeFixture(
  run: (service: KnowledgeService, db: ProjectDatabase) => void | Promise<void>,
): Promise<void> {
  await withEntityDatabase(async (db) => {
    await run(new KnowledgeService(db), db);
  });
}

/**
 * Создаёт одну фичу, её сценарий и приложение с доской; реализаций ещё нет.
 * Использует переданный сервис и не владеет соединением.
 */
export async function createKnowledgeRequirements(
  service: KnowledgeService,
): Promise<KnowledgeRequirements> {
  const feature = await service.create("feature", { name: "Поиск" }, "tester");
  const scenario = await service.create(
    "scenario",
    { name: "Найти по имени", feature: feature.key },
    "tester",
  );
  const application = await service.create(
    "application",
    { name: "Web", slug: "web", prefix: "WEB" },
    "tester",
  );
  return { feature, scenario, application };
}

/**
 * Создаёт требования и выбирает обе цели одним составом, намеренно передавая сценарий первым.
 * Возвращает ревизию приложения после участия и обе реализации; отсутствие любой — отказ fixture.
 */
export async function createKnowledgeParticipation(
  service: KnowledgeService,
): Promise<KnowledgeParticipation> {
  const requirements = await createKnowledgeRequirements(service);
  const application = await service.replaceParticipation(
    requirements.application.key,
    [requirements.scenario.key, requirements.feature.key],
    entityWriteOptions(requirements.application),
  );
  const featureImplementation = service.list("implementation", {
    target: requirements.feature.id,
  })[0];
  const scenarioImplementation = service.list("implementation", {
    target: requirements.scenario.id,
  })[0];
  if (!featureImplementation || !scenarioImplementation) {
    throw new Error("Подготовка участия не создала FI и SI");
  }
  return { ...requirements, application, featureImplementation, scenarioImplementation };
}

/**
 * Намеренно повреждает payload через Storage, обходя правила KnowledgeService.
 * Повышает ревизию переданного снимка на один и возвращает точное записанное состояние.
 */
export function corruptKnowledgeRecord(
  db: ProjectDatabase,
  entity: EntityRecord,
  patch: Readonly<Record<string, unknown>>,
): EntityRecord {
  const corruptedRecord = {
    ...entity,
    revision: entity.revision + 1,
    data: { ...entity.data, ...patch },
  };
  db.update(corruptedRecord, entity.revision);
  return corruptedRecord;
}
