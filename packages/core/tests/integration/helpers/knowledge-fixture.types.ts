import type { KnowledgeRecord } from "@relay/contracts";

/**
 * Минимальные требования с одним сценарием и приложением без участия в них.
 */
export interface KnowledgeRequirements {
  /* Фича, которой принадлежит сценарий. */
  readonly feature: KnowledgeRecord<"feature">;
  /* Сценарий фичи; его реализация требует FI того же приложения. */
  readonly scenario: KnowledgeRecord<"scenario">;
  /* Приложение с собственной доской и пустым составом реализаций. */
  readonly application: KnowledgeRecord<"application">;
}

/**
 * Минимальное участие приложения в фиче и её сценарии с актуальной ревизией владельца.
 */
export interface KnowledgeParticipation extends Omit<KnowledgeRequirements, "application"> {
  /* Приложение после выбора обеих целей; ревизия включает изменение состава. */
  readonly application: KnowledgeRecord<"application">;
  /* Активная реализация фичи приложения. */
  readonly featureImplementation: KnowledgeRecord<"implementation">;
  /* Активная реализация сценария того же приложения. */
  readonly scenarioImplementation: KnowledgeRecord<"implementation">;
}
