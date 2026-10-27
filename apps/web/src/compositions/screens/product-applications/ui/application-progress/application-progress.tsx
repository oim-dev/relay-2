import clsx from "clsx";
import { Button, Progress, Skeleton, Stack, Text } from "@mantine/core";
import { useApplicationTaskProgress } from "domains/board-tasks";
import { useProjectId } from "domains/project";
import { isDefined } from "shared/value-predicates";
import type { ApplicationProgressProps } from "./types/application-progress-props.type";
import styles from "./styles/application-progress.module.css";

/**
 * Показывает выполнение задач с явными целями и всей доски, не готовность приложения.
 *
 * Используется для:
 *  - сравнения прогресса приложений без открытия досок
 *  - различения пустой доски, загрузки и недоступных данных
 */
export const ApplicationProgress = (props: ApplicationProgressProps) => {
  const { board, className, ...rootAttrs } = props;
  const project = useProjectId();
  const query = useApplicationTaskProgress(project, board);
  const progressData = query.data;

  if (isDefined(query.error)) {
    return (
      <div {...rootAttrs} className={clsx(styles.root, className)}>
        <Text size="sm" c="dimmed" role="status">
          Не удалось загрузить прогресс
        </Text>
        <Button
          className={styles.retry}
          variant="light"
          color="gray"
          size="compact-sm"
          loading={query.isValidating}
          onClick={() => void query.mutate().catch(() => undefined)}
        >
          Повторить
        </Button>
      </div>
    );
  }

  if (!isDefined(progressData)) {
    return (
      <div
        {...rootAttrs}
        className={clsx(styles.root, className)}
        aria-busy="true"
        aria-label="Загрузка прогресса"
      >
        <Stack gap="sm">
          <Skeleton height={15} width="65%" />
          <Skeleton height={8} />
          <Skeleton height={12} width="45%" />
        </Stack>
        <Stack gap="sm">
          <Skeleton height={15} width="65%" />
          <Skeleton height={6} />
          <Skeleton height={12} width="45%" />
        </Stack>
      </div>
    );
  }

  const progressItems = [
    {
      id: "business",
      label: "Задачи с целями",
      description: "Явно связанные с предметными целями",
      empty: "Нет связанных задач",
      ...progressData.business,
    },
    {
      id: "overall",
      label: "Все задачи доски",
      description: "Не показатель готовности приложения",
      empty: "На доске пока нет задач",
      ...progressData.overall,
    },
  ].map((entry) => {
    const hasTasks = entry.total > 0;
    const isBusiness = entry.id === "business";
    const percent = hasTasks ? Math.floor((entry.completed / entry.total) * 100) : 0;
    return {
      ...entry,
      percent,
      percentLabel: hasTasks ? `${percent}%` : "—",
      countLabel: hasTasks ? `${entry.completed} / ${entry.total} выполнено` : entry.empty,
      accessibleLabel: `${entry.label}: ${entry.completed} из ${entry.total} задач выполнено`,
      color: isBusiness ? "teal" : "gray",
      size: isBusiness ? 8 : 6,
      className: clsx(styles.metric, isBusiness && styles._business),
    };
  });

  return (
    <div {...rootAttrs} className={clsx(styles.root, className)}>
      {progressItems.map((entry) => (
        <div key={entry.id} className={entry.className}>
          <div className={styles.heading}>
            <span className={styles.label}>{entry.label}</span>
            <strong className={styles.percent}>{entry.percentLabel}</strong>
          </div>
          <Progress
            value={entry.percent}
            color={entry.color}
            size={entry.size}
            radius="xl"
            aria-label={entry.accessibleLabel}
          />
          <div className={styles.caption}>
            <span>{entry.description}</span>
            <span className={styles.count}>{entry.countLabel}</span>
          </div>
        </div>
      ))}
    </div>
  );
};
