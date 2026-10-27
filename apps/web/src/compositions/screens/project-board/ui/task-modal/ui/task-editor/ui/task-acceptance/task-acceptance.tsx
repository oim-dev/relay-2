import { useRef, useState } from "react";
import clsx from "clsx";
import { Alert, Button, Group, Stack, Text, Title } from "@mantine/core";
import { Plus } from "lucide-react";
import {
  BoardTaskError,
  changeTaskCriterion,
  getTaskCriterion,
  useBoardTaskRefresh,
  useTaskCriteria,
} from "domains/board-tasks";
import type { ChangeCriterionInput, CriterionSummary, TaskSaved } from "domains/board-tasks";
import { readSessionStored, removeSessionStored } from "infra/browser-storage";
import { isDefined, isEmptyArray } from "shared/value-predicates";
import { ACCEPTANCE_DRAFT_SCHEMA } from "./config/acceptance-draft.schema";
import type { AcceptanceDraft } from "./config/acceptance-draft.schema";
import { CriterionRow } from "./ui/criterion-row/criterion-row";
import { CriterionForm } from "./ui/criterion-form/criterion-form";
import type { TaskAcceptanceProps } from "./types/task-acceptance-props.type";
import styles from "./styles/task-acceptance.module.css";

/**
 * Управляет условиями приёмки в окне задачи.
 *
 * Используется для:
 *  - чтения критериев и адресного раскрытия полного описания
 *  - редактирования условий и фиксации их выполнения
 */
export const TaskAcceptance = (props: TaskAcceptanceProps) => {
  const { projectId, task, onOwnRevision, className, ...rootAttrs } = props;
  const draftKey = `relay:acceptance:${projectId}:${task.id}`;
  const [editorData, setEditorData] = useState<AcceptanceDraft | null>(() => {
    const restored = ACCEPTANCE_DRAFT_SCHEMA.safeParse(readSessionStored(draftKey));
    return restored.success ? restored.data : null;
  });
  const [count, setCount] = useState(20);
  const [isBusy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [defect, setDefect] = useState<unknown>();
  const [removalData, setRemovalData] = useState<CriterionSummary | null>(null);
  const requestRef = useRef<{ fingerprint: string; id: string } | null>(null);
  const lockRef = useRef(false);
  const query = useTaskCriteria(projectId, task.id, count);
  const refresh = useBoardTaskRefresh(projectId);
  const criteriaData = query.data;
  const criteriaItems = criteriaData?.items ?? [];
  const isLocked = task.column === "done";
  const hasEditor = isDefined(editorData);
  const hasError = error !== "";
  const hasLoadError = isDefined(query.error);
  const shouldShowEmpty = !query.isLoading && !hasLoadError && isEmptyArray(criteriaItems);
  const hasMore = isDefined(criteriaData) && criteriaData.nextOffset !== null;
  const isDisabled = isBusy || isLocked || hasEditor;
  const canAdd = !isDisabled && task.acceptance.total < 100;
  const progressLabel = `Выполнено ${task.acceptance.completed} из ${task.acceptance.total}`;
  const removalLabel = `Удалить критерий «${removalData?.title ?? ""}»?`;

  /**
   * Показывает ожидаемый отказ, сохраняя ввод пользователя.
   */
  const handleFailure = (failure: unknown): void => {
    if (failure instanceof BoardTaskError) setError(failure.message);
    else setDefect(failure);
  };
  /**
   * Проводит запись и синхронизирует все представления задачи.
   */
  const handleWrite = async (input: ChangeCriterionInput): Promise<TaskSaved> => {
    const saved = await changeTaskCriterion(projectId, task.id, input);
    onOwnRevision(saved.revision);
    await refresh(task.id);
    return saved;
  };
  /**
   * Записывает отметку или удаление с тем же ключом при потере ответа.
   */
  const handleQuickChange = async (criterionId: string, completed?: boolean): Promise<void> => {
    if (lockRef.current) return;
    lockRef.current = true;
    setBusy(true);
    setError("");
    const fingerprint = JSON.stringify([criterionId, completed, task.revision]);
    if (requestRef.current?.fingerprint !== fingerprint)
      requestRef.current = { fingerprint, id: crypto.randomUUID() };
    const writeData = { criterionId, ifRevision: task.revision, requestId: requestRef.current.id };
    try {
      if (completed === undefined) await handleWrite({ ...writeData, action: "remove" });
      else await handleWrite({ ...writeData, action: "complete", completed });
      requestRef.current = null;
      setRemovalData(null);
    } catch (failure) {
      handleFailure(failure);
    } finally {
      lockRef.current = false;
      setBusy(false);
    }
  };
  /**
   * Открывает форму создания с текущей ревизией задачи.
   */
  const handleAdd = (): void => {
    setError("");
    setRemovalData(null);
    setEditorData({
      criterionId: null,
      revision: task.revision,
      wasCompleted: false,
      values: { title: "", summary: "", description: "" },
    });
  };
  /**
   * Получает полный текст перед началом редактирования.
   */
  const handleEdit = async (criterionId: string): Promise<void> => {
    if (lockRef.current) return;
    lockRef.current = true;
    setBusy(true);
    setError("");
    setRemovalData(null);
    try {
      const currentData = await getTaskCriterion(projectId, task.id, criterionId);
      const { title, summary, description, completed } = currentData.criterion;
      setEditorData({
        criterionId,
        revision: currentData.revision,
        wasCompleted: completed,
        values: { title, summary, description },
      });
    } catch (failure) {
      handleFailure(failure);
    } finally {
      lockRef.current = false;
      setBusy(false);
    }
  };
  /**
   * Закрывает явно сохранённый или отменённый черновик.
   */
  const handleCloseEditor = (): void => {
    removeSessionStored(draftKey);
    setEditorData(null);
  };
  if (isDefined(defect)) throw defect;
  return (
    <section {...rootAttrs} className={clsx(styles.root, className)} aria-label="Критерии приёмки">
      <Group justify="space-between" align="flex-start" gap="xs">
        <Stack gap={2}>
          <Title order={3} size="sm">
            Критерии приёмки
          </Title>
          <Text size="xs" c="dimmed" aria-live="polite">
            {progressLabel}
          </Text>
        </Stack>
        <Button
          size="xs"
          variant="subtle"
          leftSection={<Plus size={14} />}
          onClick={handleAdd}
          disabled={!canAdd}
        >
          Добавить критерий
        </Button>
      </Group>
      {isLocked && (
        <Text size="xs" c="dimmed">
          Для изменения критериев верните задачу из «Готово».
        </Text>
      )}
      {query.isLoading && (
        <Text size="sm" c="dimmed" role="status">
          Загружаем критерии…
        </Text>
      )}
      {hasLoadError && (
        <Alert color="red" title="Критерии недоступны">
          <Button size="xs" variant="subtle" onClick={() => void query.mutate()}>
            Повторить загрузку
          </Button>
        </Alert>
      )}
      {shouldShowEmpty && (
        <Text size="sm" c="dimmed">
          Критерии приёмки не заданы.
        </Text>
      )}
      <Stack gap={0}>
        {criteriaItems.map((criterion) => (
          <CriterionRow
            key={criterion.id}
            projectId={projectId}
            taskId={task.id}
            criterion={criterion}
            isDisabled={isDisabled}
            onComplete={(completed) => void handleQuickChange(criterion.id, completed)}
            onEdit={() => void handleEdit(criterion.id)}
            onRemove={() => setRemovalData(criterion)}
          />
        ))}
      </Stack>
      {hasMore && (
        <Button
          size="xs"
          variant="subtle"
          loading={query.isValidating}
          onClick={() => setCount((previous) => Math.min(previous + 20, 100))}
        >
          Показать ещё критерии
        </Button>
      )}
      {isDefined(removalData) && (
        <Alert color="orange" title={removalLabel}>
          <Group gap="xs">
            <Button
              size="xs"
              color="red"
              loading={isBusy}
              disabled={isLocked}
              onClick={() => void handleQuickChange(removalData.id)}
            >
              Удалить критерий
            </Button>
            <Button
              size="xs"
              variant="subtle"
              disabled={isBusy}
              onClick={() => setRemovalData(null)}
            >
              Отмена
            </Button>
          </Group>
        </Alert>
      )}
      {hasError && (
        <Alert color="red" title="Действие не сохранено" role="alert">
          {error}
        </Alert>
      )}
      {isDefined(editorData) && (
        <CriterionForm
          key={editorData.criterionId ?? "new"}
          initialData={editorData}
          draftKey={draftKey}
          currentRevision={task.revision}
          isLocked={isLocked}
          onSave={handleWrite}
          onClose={handleCloseEditor}
        />
      )}
    </section>
  );
};
