import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Alert, Button } from "@mantine/core";
import { useProjectBasePath, useProjectId } from "domains/project";
import {
  createPlanDraft,
  usePlan,
  savePlan,
  usePlanningRefresh,
  PlanningError,
} from "domains/planning";
import type { PlanningPlan } from "domains/planning";
import { StatePanel } from "ui/state-panel";
import { isDefined } from "shared/value-predicates";
import { PlanCatalog } from "./ui/plan-catalog";
import { PlanDetail } from "./ui/plan-detail";
import { PlanForm } from "./ui/plan-form";
import styles from "./styles/planning-workspace.module.css";

/** Открытая форма с самостоятельной идентичностью черновика. */
type EditorState = {
  /** Исходное содержимое формы. */
  plan: PlanningPlan;
  /** Создание вместо изменения. */
  isNew: boolean;
};

/**
 * Соединяет серверный каталог, подробности и независимый черновик плана.
 *
 * Используется для:
 *  - работы с целями, этапами и задачами в общем каркасе проекта
 */
export const PlanningWorkspace = () => {
  const basePath = useProjectBasePath();
  const projectId = useProjectId();
  const navigate = useNavigate();
  const { planId } = useParams();
  const planQuery = usePlan(projectId, planId ?? null);
  const refresh = usePlanningRefresh(projectId);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const planData = planQuery.data;
  const hasUnknownPlan =
    planQuery.error instanceof PlanningError && planQuery.error.code === "ENTITY_NOT_FOUND";

  /**
   * Открывает компактное создание без записи пустой сущности.
   */
  const handleCreate = () => {
    setEditor({
      plan: createPlanDraft(),
      isNew: true,
    });
  };

  /**
   * После сохранения открывает адрес созданного или изменённого плана.
   */
  const handleFormSave = async (plan: PlanningPlan): Promise<string | null> => {
    try {
      const saved = await savePlan(projectId, plan);
      void refresh().catch(() => undefined);
      navigate(`${basePath}/plans/${saved.id}`);
      return null;
    } catch (error) {
      if (error instanceof PlanningError) return error.message;
      throw error;
    }
  };

  if (isDefined(planId) && planQuery.isLoading)
    return (
      <StatePanel
        title="Загружаем план"
        titleAs="h1"
        description="Читаем постоянные данные проекта."
      />
    );
  if (isDefined(planQuery.error) && !hasUnknownPlan && !isDefined(planData)) {
    return (
      <StatePanel
        title="Не удалось прочитать план"
        titleAs="h1"
        description={planQuery.error.message}
        action={<Button onClick={() => void planQuery.mutate()}>Повторить чтение</Button>}
      />
    );
  }

  if (hasUnknownPlan && !isDefined(planData)) {
    return (
      <StatePanel
        title="План не найден"
        titleAs="h1"
        description="В выбранном проекте нет плана с таким адресом."
        action={
          <Button component={Link} to={`${basePath}/plans`}>
            К планам
          </Button>
        }
      />
    );
  }

  return (
    <section className={styles.root}>
      {isDefined(planQuery.error) && (
        <Alert color="red" title="Не удалось обновить план">
          {planQuery.error.message}
          <Button size="xs" onClick={() => void planQuery.mutate()}>
            Повторить
          </Button>
        </Alert>
      )}
      {!isDefined(planId) && <PlanCatalog basePath={basePath} onCreate={handleCreate} />}
      {isDefined(planData) && (
        <PlanDetail
          key={`detail-${planData.id}`}
          plan={planData}
          basePath={basePath}
          onEdit={() => setEditor({ plan: planData, isNew: false })}
        />
      )}
      {isDefined(editor) && (
        <PlanForm
          key={`editor-${editor.plan.id}`}
          plan={editor.plan}
          isNew={editor.isNew}
          projectId={projectId}
          onSave={handleFormSave}
          onClose={() => setEditor(null)}
        />
      )}
    </section>
  );
};
