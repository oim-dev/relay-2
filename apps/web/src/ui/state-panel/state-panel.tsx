import clsx from "clsx";
import { Loader } from "@mantine/core";
import { Layers3 } from "lucide-react";
import type { StatePanelProps } from "./types/state-panel-props.type";
import styles from "./styles/state-panel.module.css";

/**
 * Объясняет пустое состояние, ожидание или отказ и предлагает следующий шаг.
 *
 * Используется для:
 *  - загрузки проекта, пустой доски и ошибок чтения
 */
export const StatePanel = (props: StatePanelProps) => {
  const {
    title,
    titleAs: Heading = "h2",
    description,
    action,
    isLoading = false,
    className,
    ...rootAttrs
  } = props;
  const StatusIcon = isLoading ? Loader : Layers3;
  return (
    <div {...rootAttrs} className={clsx(styles.root, className)} role="status">
      <div className={styles.icon}>
        <StatusIcon size={24} />
      </div>
      <Heading className={styles.title}>{title}</Heading>
      <p className={styles.description}>{description}</p>
      {action}
    </div>
  );
};
