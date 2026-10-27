import clsx from "clsx";
import { Badge } from "@mantine/core";
import { Link } from "react-router-dom";
import { ArrowUpRight, Flag } from "lucide-react";
import { useProductPath } from "compositions/widgets/product-page";
import type { WorkPlanProps } from "./types/work-plan-props.type";
import styles from "./styles/work-plan.module.css";

/**
 * Показывает краткие результаты задач с группировкой по этапам плана.
 *
 * Используется для:
 *  - переходов к подробностям и понимания работы текущего цикла
 */
export const WorkPlan = (props: WorkPlanProps) => {
  const { plan, stages, tasks, returnTo, className, ...rootAttrs } = props;
  const base = useProductPath();
  const isDone = plan.status === "done";
  const planLabel = isDone ? "Завершён" : "Текущий план";
  const planColor = isDone ? "gray" : "blue";
  const stageItems = stages
    .filter((stage) => stage.parentId === plan.id)
    .map((stage) => ({
      ...stage,
      taskItems: tasks
        .filter((task) => task.parentId === stage.id)
        .map((task) => ({
          ...task,
          statusLabel: { done: "Готово", active: "В работе", planned: "Запланировано" }[
            task.status
          ],
          color: { done: "teal", active: "blue", planned: "gray" }[task.status],
        })),
    }));
  return (
    <article {...rootAttrs} className={clsx(styles.root, className)}>
      <header className={styles.header}>
        <Link to={`${base}/work/${plan.id}`} state={{ returnTo }} className={styles.planLink}>
          <Flag size={15} aria-hidden="true" />
          {plan.name}
          <ArrowUpRight size={14} aria-hidden="true" />
        </Link>
        <Badge size="sm" variant="light" color={planColor}>
          {planLabel}
        </Badge>
      </header>
      {stageItems.map((stage) => (
        <section key={stage.id} className={styles.stage}>
          <h3 className={styles.stageTitle}>
            <span className={styles.stageLabel}>ЭТАП</span>
            <Link to={`${base}/work/${stage.id}`} state={{ returnTo }} className={styles.stageLink}>
              {stage.name}
            </Link>
          </h3>
          <ul className={styles.tasks}>
            {stage.taskItems.map((task) => (
              <li key={task.id} className={styles.task}>
                <div className={styles.taskHeading}>
                  <Link
                    to={`${base}/work/${task.id}`}
                    state={{ returnTo }}
                    className={styles.taskLink}
                  >
                    {task.name}
                  </Link>
                  <Badge size="xs" variant="light" color={task.color}>
                    {task.statusLabel}
                  </Badge>
                </div>
                <p className={styles.result}>{task.result}</p>
                <Link
                  to={`${base}/work/${task.id}`}
                  state={{ returnTo }}
                  className={styles.details}
                >
                  Подробности задачи
                  <ArrowUpRight size={12} aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </article>
  );
};
