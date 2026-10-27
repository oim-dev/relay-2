import { useState } from "react";
import { ActionIcon, Alert, Button, Group } from "@mantine/core";
import { ArrowDown, ArrowUp, Check, ChevronDown, Pencil, Plus, Trash2 } from "lucide-react";
import { usePlanStageTasks } from "domains/planning";
import { useProjectId } from "domains/project";
import { MarkdownView } from "ui/markdown-view";
import { isDefined } from "shared/value-predicates";
import { PlanTask } from "../plan-task/plan-task";
import type { StageRowProps } from "./types/stage-row-props.type";
import styles from "../../styles/plan-stages.module.css";

/**
 * Сохраняет оформление этапа и независимо подгружает его реальные задачи.
 *
 * Используется для:
 *  - раскрытия результата этапа и полного серверного прогресса
 *  - чтения задач страницами без потери открытого состояния
 */
export const StageRow = (props: StageRowProps) => {
  const {
    planId,
    stage,
    index,
    total,
    canEdit,
    isBusy,
    onOpenTask,
    onEdit,
    onChoose,
    onRemove,
    onMove,
  } = props;
  const projectId = useProjectId();
  const isEmpty = stage.progress.total === 0;
  const isDone = stage.progress.completed;
  const isActive = !isEmpty && !isDone;
  const hasPartialCompletion = !isDone && stage.progress.done > 0;
  const [isExpanded, setIsExpanded] = useState(isActive || isEmpty);
  const [limit, setLimit] = useState(12);
  const query = usePlanStageTasks(projectId, planId, stage.id, limit, isExpanded);
  const taskItems = query.data?.items ?? [];
  const hasMore = isDefined(query.data?.nextOffset);
  const hasError = isDefined(query.error);
  const label = isDone
    ? "Задачи готовы"
    : isActive
      ? "В работе"
      : hasPartialCompletion
        ? "Частично выполнен"
        : "Предстоит";
  const ordinal = String(index + 1).padStart(2, "0");
  const isFirst = index === 0;
  const isLast = index + 1 >= total;
  const hasConditions = stage.completionConditions.trim() !== "";
  return (
    <details
      className={styles.stage}
      open={isExpanded}
      data-done={isDone}
      data-active={isActive}
      onToggle={(event) => setIsExpanded(event.currentTarget.open)}
    >
      <summary className={styles.stageHeader}>
        <span className={styles.marker} data-done={isDone} data-active={isActive}>
          {isDone && <Check size={17} />}
          {!isDone && <span>{ordinal}</span>}
        </span>
        <span className={styles.stageIdentity}>
          <span className={styles.stageTitle}>{stage.title}</span>
          <span className={styles.stageMeta}>
            {label}
            <span className={styles.metaDivider} aria-hidden="true">
              ·
            </span>
            {stage.progress.done} из {stage.progress.total} задач
          </span>
        </span>
        <span className={styles.miniProgress} aria-hidden="true">
          <span style={{ width: `${stage.progress.percent}%` }} />
        </span>
        <ChevronDown
          size={16}
          className={styles.chevron}
          data-open={isExpanded}
          aria-hidden="true"
        />
      </summary>
      <div className={styles.stageBody}>
        <div className={styles.outcome}>
          <span className={styles.outcomeLabel}>РЕЗУЛЬТАТ ЭТАПА</span>
          <MarkdownView text={stage.outcome} compact emptyText="Результат этапа ещё не описан." />
          {hasConditions && <MarkdownView text={stage.completionConditions} compact />}
        </div>
        {query.isLoading && <p role="status">Загружаем задачи…</p>}
        {hasError && (
          <Alert color="red">
            {query.error?.message}
            <Button size="xs" variant="subtle" onClick={() => void query.mutate()}>
              Повторить
            </Button>
          </Alert>
        )}
        <div className={styles.taskList} role="group" aria-label={`Задачи этапа «${stage.title}»`}>
          {taskItems.map((task) => (
            <PlanTask key={task.id} task={task} onOpen={() => onOpenTask(task.id)} />
          ))}
        </div>
        {isEmpty && (
          <p className={styles.noTasks}>
            Задач пока нет. Выберите существующие задачи с любой доски.
          </p>
        )}
        {hasMore && (
          <Button
            variant="subtle"
            size="xs"
            fullWidth
            loading={query.isValidating}
            onClick={() => setLimit(limit + 12)}
          >
            Показать ещё · {taskItems.length} из {query.data?.total}
          </Button>
        )}
        {canEdit && (
          <div className={styles.stageActions}>
            <Button
              variant="subtle"
              size="xs"
              leftSection={<Plus size={13} />}
              disabled={isBusy}
              onClick={onChoose}
            >
              Выбрать задачи
            </Button>
            <Group gap={2}>
              <ActionIcon
                disabled={isBusy}
                aria-label={`Изменить этап «${stage.title}»`}
                onClick={onEdit}
              >
                <Pencil size={13} />
              </ActionIcon>
              <ActionIcon
                disabled={isBusy || isFirst}
                aria-label={`Поднять этап «${stage.title}»`}
                onClick={() => onMove("up")}
              >
                <ArrowUp size={13} />
              </ActionIcon>
              <ActionIcon
                disabled={isBusy || isLast}
                aria-label={`Опустить этап «${stage.title}»`}
                onClick={() => onMove("down")}
              >
                <ArrowDown size={13} />
              </ActionIcon>
              {isEmpty && (
                <ActionIcon
                  color="red"
                  disabled={isBusy}
                  aria-label={`Удалить пустой этап «${stage.title}»`}
                  onClick={onRemove}
                >
                  <Trash2 size={13} />
                </ActionIcon>
              )}
            </Group>
          </div>
        )}
      </div>
    </details>
  );
};
