import type {
  CommandEffect,
  EntityIdentity,
  KnowledgeKind,
  KnowledgeRecord,
} from "@relay/contracts";
import type { CommandEntityAllocation } from "../commands/command-context.types";
import type { KnowledgeReference } from "./knowledge.types";

/**
 * Происхождение готового перехода; replication сохраняет консервативную legacy-проверку immutable полей.
 */
export interface KnowledgeTransitionContext {
  /* Имя исходной команды или replication при отсутствии надёжной границы команды в старом формате. */
  readonly operation: string;
  /* Выбранный либо заранее выделенный scoped ID раздела; обязателен для document.section.*. */
  readonly sectionId?: string;
  /* Явная цель перемещения раздела; null означает конец, отсутствие — роль не передавалась. */
  readonly beforeSectionId?: string | null;
}

/**
 * Точный результат чистого расчёта; эффекты сохраняются по порядку без схлопывания ревизий.
 */
export interface KnowledgeDelta<K extends KnowledgeKind = KnowledgeKind> {
  /* Сырая проверенная запись: исторический sectionId документа не проецируется. */
  readonly record: KnowledgeRecord<K>;
  /* Только фактические изменения, пустой массив означает no-op. */
  readonly effects: readonly CommandEffect[];
}

/**
 * Наблюдение занятости одного адреса до применения эффектов текущего шага.
 */
export interface KnowledgeAddressObservation {
  /* Буквальный ID, ключ, slug либо prefix. */
  readonly ref: string;
  /* Владелец прямого ID/ключа/алиаса; null доказывает отсутствие. */
  readonly direct: EntityIdentity | null;
  /* Совпадения виртуального адреса того же вида, включая пустой набор. */
  readonly virtual: readonly EntityIdentity[];
  /* Ключ и ID глобальны, slug/prefix проверяются внутри вида. */
  readonly scope: "global" | "kind";
}

/**
 * Заранее выделенные метаданные и защищённые адресные предикаты создания.
 */
export interface KnowledgeAllocation extends CommandEntityAllocation {
  /* Готовый ключ; counter зарезервирован только в разреженном контексте. */
  readonly key: string;
  /* Занятость ID/ключа и виртуальных адресов без содержания чужих карточек. */
  readonly addresses: readonly KnowledgeAddressObservation[];
}

/**
 * Приложение и его полная история участия одного anchor, без чужих реализаций.
 */
export interface KnowledgeParticipationContext {
  /* Владелец CAS состава. */
  readonly application: KnowledgeRecord<"application">;
  /* Все активные и снятые реализации только данного приложения. */
  readonly existing: readonly KnowledgeRecord<"implementation">[];
}

/**
 * Выбранная ссылка участия и исходная цель реализации, если ссылка указывает на FI/SI.
 */
export interface KnowledgeParticipationSelection {
  /* Декодированная исходная ссылка; принадлежность реализации проверяет calculator. */
  readonly reference: KnowledgeReference;
  /* Исходная цель FI/SI; null для непосредственной ссылки на фичу/сценарий. */
  readonly target: KnowledgeReference | null;
  /* Выделение для ещё отсутствующего участия; null для исторического участия. */
  readonly allocation: KnowledgeAllocation | null;
}

/**
 * Рассчитанное участие и затронутые реализации без дополнительных выборок before/after.
 */
export interface KnowledgeParticipationDelta extends KnowledgeDelta<"application"> {
  /* Созданные или фактически изменённые реализации в порядке эффектов. */
  readonly changed: readonly KnowledgeRecord<"implementation">[];
}
