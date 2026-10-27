import type { ProductEntitySummary } from "../types/product-entity.type";

/** Адресный вариант выбора общей области либо контракта приложения. */
export type ProductContextOption = {
  id: string;
  key?: string | undefined;
  title: string;
  path: string;
  kind: string;
  description: string;
  targetKind: "feature" | "scenario" | "implementation";
  /** Вид требования, в том числе для самостоятельной имплементации приложения. */
  requirementKind: "feature" | "scenario";
  applicationId: string | null;
  isActive: boolean;
};

/** Переводит краткие серверные сведения в варианты выбора, не подгружая описание. */
export const getProductTargetOptions = (items: ProductEntitySummary[]): ProductContextOption[] =>
  items.flatMap((item) => {
    if (item.kind !== "feature" && item.kind !== "scenario" && item.kind !== "implementation")
      return [];
    return [
      {
        id: item.id,
        key: item.key,
        title: item.title,
        targetKind: item.kind,
        requirementKind:
          item.kind === "scenario" || (item.kind === "implementation" && item.scenarioId !== null)
            ? "scenario"
            : "feature",
        kind:
          item.kind === "feature"
            ? "Фича"
            : item.kind === "scenario"
              ? "Сценарий"
              : item.scenarioId === null
                ? "Реализация фичи"
                : "Реализация сценария",
        applicationId: item.applicationId,
        isActive: item.active,
        description: "",
        path:
          [item.applicationName, item.targetKey, item.targetName].filter(Boolean).join(" · ") ||
          "Общие требования продукта",
      },
    ];
  });
