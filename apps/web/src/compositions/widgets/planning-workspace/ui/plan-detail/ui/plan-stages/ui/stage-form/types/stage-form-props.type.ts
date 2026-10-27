import type { PlanStage } from "domains/planning";

/** Параметры визуальной области. */
export type StageFormProps = {
  /** Новый либо существующий этап. */
  stage: PlanStage;
  /** Ревизия плана при открытии редактора. */
  revision: number;
  /** Адрес черновика в пределах проекта и плана. */
  draftKey: string;
  /** Признак нового этапа. */
  isNew: boolean;
  /** Применить изменения. */
  onSave: (stage: PlanStage, revision: number) => Promise<string | null>;
  /** Свернуть редактор. */
  onClose: () => void;
};
