import { Check, Circle, CircleAlert, CircleDot, ScanEye } from "lucide-react";
import { PLANNING_TASK_LABELS } from "domains/planning";
import { isDefined } from "shared/value-predicates";
import type { PlanTaskProps } from "./types/plan-task-props.type";
import styles from "./styles/plan-task.module.css";

/**
 * Представляет задачу компактной строкой с собственной доской и состоянием.
 *
 * Используется для:
 *  - просмотра состава этапа и объяснения внешнего ожидания
 */
export const PlanTask = (props: PlanTaskProps) => {
  const { task, onOpen } = props;
  const Icon = task.isCompleted
    ? Check
    : {
        done: CircleAlert,
        "in-progress": CircleDot,
        review: ScanEye,
        inbox: Circle,
        ready: Circle,
        cancelled: Circle,
      }[task.status];
  const colorStatus = task.status === "in-progress" ? "active" : task.status;
  const hasBlocker = isDefined(task.blocker);
  return (
    <button className={styles.root} type="button" onClick={onOpen}>
      <span className={styles.statusIcon} data-status={colorStatus}>
        <Icon size={15} aria-hidden="true" />
      </span>
      <span className={styles.body}>
        <span className={styles.title}>{task.title}</span>
        <span className={styles.meta}>
          <span className={styles.key}>{task.key}</span>
          <span>{task.board}</span>
        </span>
        {hasBlocker && (
          <span className={styles.blocker}>
            <CircleAlert size={12} aria-hidden="true" />
            {task.blocker}
          </span>
        )}
      </span>
      <span className={styles.status} data-status={colorStatus}>
        {PLANNING_TASK_LABELS[task.status]}
      </span>
    </button>
  );
};
