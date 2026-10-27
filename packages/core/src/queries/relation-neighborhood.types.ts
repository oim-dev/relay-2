import type { RelationViewEdge, RelationViewNode } from "@relay/contracts";

/**
 * Проверенный граф структурированных ссылок одного metadata-снимка.
 */
export interface RelationIndex {
  /* Компактные узлы по постоянному ID. */
  readonly nodes: Map<string, RelationViewNode>;
  /* Упорядоченные структурированные рёбра. */
  readonly edges: RelationViewEdge[];
}

/**
 * Один направленный шаг и фактическое ребро, которым он объясняется.
 */
export interface RelationStep {
  /* Следующий постоянный ID. */
  readonly id: string;
  /* ID исходного ребра, не перевёрнутая запись. */
  readonly edge: string;
}
