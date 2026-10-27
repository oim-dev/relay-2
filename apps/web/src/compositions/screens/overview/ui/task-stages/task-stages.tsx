import type { CSSProperties } from "react";
import clsx from "clsx";
import { Progress } from "@mantine/core";
import { TASK_COLUMNS } from "domains/board-tasks";
import { OVERVIEW_SECTION_IDS, TASK_STATE_ICONS } from "../../config/overview.config";
import type { TaskStagesProps } from "./types/task-stages-props.type";
import styles from "./styles/task-stages.module.css";

/**
 * Геометрия столбца: доля от самой заполненной колонки (0–1) и число знаков подписи,
 * по которому размер числа подстраивается под ширину слота.
 */
type ShareStyle = CSSProperties & Record<"--share" | "--digits", string>;

/**
 * Показывает, в какой колонке сейчас находится каждая задача проекта, столбиковой
 * диаграммой с подписью и числом у каждого столбца, и пересекающиеся показатели
 * выполнения тех же задач. Числа читаются текстом; столбцы скрыты от скринридера.
 *
 * Используется для:
 *  - оценки текущей стадии работы без интерпретации цвета
 *  - отличия фактического выполнения от колонки «Готово»
 */
export const TaskStages = (props: TaskStagesProps) => {
  const { tasks, className, ...rootAttrs } = props;
  const largestCount = Math.max(...TASK_COLUMNS.map((column) => tasks.byColumn[column.value]));
  const stageItems = TASK_COLUMNS.map((column) => {
    const count = tasks.byColumn[column.value];
    // Высота столбца — геометрия диаграммы; само число подписано текстом.
    const shareStyle: ShareStyle = {
      "--share": String(largestCount === 0 ? 0 : count / largestCount),
      "--digits": String(String(count).length),
    };
    return {
      value: column.value,
      label: column.label,
      count,
      Icon: TASK_STATE_ICONS[column.value],
      shareStyle,
      emptyMark: count === 0 ? "" : undefined,
    };
  });
  const { criteria } = tasks;
  const criteriaLabel =
    criteria === null
      ? `${tasks.byColumn.done} из ${tasks.total}`
      : `${criteria.completed} из ${criteria.total}`;
  const criteriaShare =
    criteria === null
      ? tasks.total === 0
        ? 0
        : (tasks.byColumn.done / tasks.total) * 100
      : criteria.total === 0
        ? 0
        : (criteria.completed / criteria.total) * 100;
  return (
    <div {...rootAttrs} className={clsx(styles.root, className)}>
      <ul className={styles.chart} aria-label="Задачи по колонкам">
        {stageItems.map((stage) => (
          <li
            key={stage.value}
            className={styles.stage}
            data-column={stage.value}
            data-empty={stage.emptyMark}
            style={stage.shareStyle}
          >
            <span className={styles.stageLabel}>{stage.label}</span>
            <span className={styles.column} aria-hidden="true">
              <stage.Icon size={16} className={styles.stageIcon} />
              <span className={styles.fill} />
            </span>
            <span className={styles.stageCount}>{stage.count}</span>
          </li>
        ))}
      </ul>
      <p className={styles.sum}>
        Сумма колонок равна всем задачам проекта:{" "}
        <strong className={styles.sumValue}>{tasks.total}</strong>
      </p>
      <section
        id={OVERVIEW_SECTION_IDS.taskFacts}
        className={styles.facts}
        aria-labelledby={`${OVERVIEW_SECTION_IDS.taskFacts}-title`}
      >
        <div className={styles.factsHeader}>
          <h3 id={`${OVERVIEW_SECTION_IDS.taskFacts}-title`} className={styles.factsTitle}>
            Состояние задач
          </h3>
          <p className={styles.factsNote}>
            Распределение по текущим колонкам. Колонка «Готово» не заменяет проверку обязательств и
            фактического результата задачи.
          </p>
        </div>
        <dl className={styles.leads}>
          <div className={styles.lead} data-fact="completed">
            <dt>В колонке «Готово»</dt>
            <dd>{tasks.byColumn.done}</dd>
          </div>
          <div className={styles.lead} data-fact="criteria">
            <dt>Доля задач в «Готово»</dt>
            <dd>
              {criteriaLabel}
              {/* Полоса повторяет подписанное число и скрыта от скринридера. */}
              <Progress
                variant="accent"
                value={criteriaShare}
                className={styles.meter}
                aria-hidden="true"
              />
            </dd>
          </div>
        </dl>
        <dl className={styles.rest}>
          <div className={styles.fact}>
            <dt>К выполнению</dt>
            <dd>{tasks.byColumn.ready}</dd>
          </div>
          <div className={styles.fact}>
            <dt>Заблокированы</dt>
            <dd>{tasks.blocked}</dd>
          </div>
          <div className={styles.fact}>
            <dt>На проверке</dt>
            <dd>{tasks.byColumn.review}</dd>
          </div>
          <div className={styles.fact}>
            <dt>Входящие</dt>
            <dd>{tasks.byColumn.inbox}</dd>
          </div>
          <div className={styles.fact}>
            <dt>Отменено</dt>
            <dd>{tasks.byColumn.cancelled}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
};
