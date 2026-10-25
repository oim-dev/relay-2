import type { ServerProject } from "@relay/contracts";

/**
 * Проверенная регистрация сервера, включая причину её недоступности.
 */
export interface ProjectChoiceProps {
  /* Одна регистрация workspace; null ID не разрешает переход. */
  readonly project: ServerProject;
}
