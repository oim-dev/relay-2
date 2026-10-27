import clsx from "clsx";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useProjectBasePath, useProjectId } from "domains/project";
import { Alert, Anchor, Badge, Button, Group, Progress, Stack, Text } from "@mantine/core";
import { ArrowUpRight, ListTodo } from "lucide-react";
import { useBoardTasks, useProductTaskProgress, TASK_COLUMNS } from "domains/board-tasks";
import { isEmptyArray } from "shared/value-predicates";
import type { ProductTasksProps } from "./types/product-tasks-props.type";
import styles from "./styles/product-tasks.module.css";

/**
 * Показывает задачи выбранной области по текущему фильтру Core, без вычисления готовности продукта.
 *
 * Используется для:
 *  - перехода от требований к работе с постраничной загрузкой
 */
export const ProductTasks = (props: ProductTasksProps) => {
  const { targetId, scope, boardHref, className, ...rootAttrs } = props;
  const isExpanded = scope !== undefined;
  const isApplication = scope === "application";
  const boardLabel = isApplication ? "Открыть доску приложения" : "Открыть продуктовую доску";
  const emptyDescription = isApplication
    ? "Создайте задачу на доске приложения и укажите эту фичу или сценарий в разделе «Реализует в приложении»."
    : "Свяжите задачу с реализацией этой фичи или сценария на доске приложения либо укажите требование в задаче продуктовой доски.";
  const progressDescription =
    "Показано фактическое выполнение задач выбранной области по текущим связям Core. Этот показатель не определяет готовность фичи, реализации или продукта.";
  const project = useProjectId();
  const base = useProjectBasePath();
  const [isOpen, setOpen] = useState(false);
  const [reasonPage, setReasonPage] = useState({
    target: targetId,
    offset: 0,
    version: undefined as string | undefined,
  });
  const reasonOffset = reasonPage.target === targetId ? reasonPage.offset : 0;
  const reasonVersion = reasonPage.target === targetId ? reasonPage.version : undefined;
  const canRead = project !== undefined && targetId !== undefined;
  const shouldShowTasks = isExpanded || isOpen;
  const query = useBoardTasks(
    project ?? "",
    { productTarget: targetId },
    canRead && shouldShowTasks,
  );
  const progress = useProductTaskProgress(
    project,
    isExpanded ? (targetId ?? null) : null,
    reasonOffset,
    reasonVersion,
  );
  const progressData = progress.data;
  const hasProgress = progressData !== undefined && progress.error === undefined;
  const progressValue =
    progressData === undefined || progressData.total === 0
      ? 0
      : Math.floor((progressData.completed / progressData.total) * 100);
  const progressLabel = `${progressData?.completed ?? 0} из ${progressData?.total ?? 0} завершено`;
  const hasProgressError = progress.error !== undefined;
  const readinessLabel = progressData?.isComplete
    ? "Все задачи выбранного набора выполнены"
    : "В выбранном наборе нет задач либо остались невыполненные";
  const reasonItems =
    progressData?.reasons.map((reason) => ({ ...reason, href: `${base}${reason.path}` })) ?? [];
  const hasMoreReasons = progressData !== undefined && progressData.nextOffset !== null;
  const canResetReasons = reasonOffset > 0;
  /**
   * Продолжает тот же снимок; при изменении пользователь явно возвращается к первой странице.
   */
  const handleNextReasons = (): void => {
    if (progressData === undefined || progressData.nextOffset === null) return;
    setReasonPage({
      target: targetId,
      offset: progressData.nextOffset,
      version: progressData.version,
    });
  };
  /**
   * Перечитывает причины после смены снимка, сохраняя состояние списка задач.
   */
  const handleResetReasons = (): void =>
    setReasonPage({ target: targetId, offset: 0, version: undefined });
  const isProgressLoading = isExpanded && progressData === undefined && !hasProgressError;
  const items =
    query.data
      ?.flatMap((page) => page.items)
      .map((task) => ({
        ...task,
        label: task.title || "Без названия",
        columnLabel:
          task.column === "done" && task.canComplete === false
            ? "Не выполнена"
            : TASK_COLUMNS.find((entry) => entry.value === task.column)?.label,
        columnTitle: `Сохранённая колонка: ${task.column}. Фактическое выполнение учитывает обязательства.`,
        color:
          task.column === "done" && task.canComplete !== false
            ? "green"
            : task.column === "cancelled"
              ? "gray"
              : "blue",
        href: `${base}/boards/${task.boardSlug}/${task.id}`,
      })) ?? [];
  const hasMore = query.data !== undefined && query.data.at(-1)?.nextOffset !== null;
  const isEmpty = isEmptyArray(items) && !query.isLoading && query.error === undefined;
  const isCollapsedMode = !isExpanded;
  const emptyLabel = isExpanded
    ? "В выбранной области пока нет задач"
    : "Явно связанных задач пока нет.";
  const hasTaskError = query.error !== undefined;
  const canOpenBoard = isExpanded && boardHref !== undefined;
  if (!canRead) return null;
  return (
    <div {...rootAttrs} className={clsx(styles.root, isExpanded && styles._expanded, className)}>
      {isCollapsedMode && (
        <Button variant="subtle" size="xs" aria-expanded={isOpen} onClick={() => setOpen(!isOpen)}>
          Задачи выбранной области
        </Button>
      )}
      {isExpanded && (
        <header className={styles.header}>
          <Group gap="xs">
            <ListTodo size={20} aria-hidden="true" />
            <Text component="h2" size="lg" fw={650}>
              Задачи выбранной области
            </Text>
          </Group>
          <Text size="sm" c="dimmed">
            {progressDescription}
          </Text>
          {isProgressLoading && (
            <Text size="sm" role="status">
              Считаем прогресс…
            </Text>
          )}
          {hasProgress && (
            <Stack gap={6} mt="sm">
              <Group justify="space-between">
                <Text size="sm" fw={600}>
                  {progressLabel}
                </Text>
                <Text size="sm" c="dimmed">
                  {progressValue}%
                </Text>
              </Group>
              <Progress value={progressValue} color="green" size={6} aria-label={progressLabel} />
              <Text size="sm">{readinessLabel}</Text>
              {reasonItems.map((reason, index) => (
                <Anchor key={`${reason.href}-${index}`} component={Link} to={reason.href} size="sm">
                  {reason.message}
                </Anchor>
              ))}
              {hasMoreReasons && (
                <Button variant="subtle" size="compact-sm" onClick={handleNextReasons}>
                  Следующие задачи набора
                </Button>
              )}
            </Stack>
          )}
          {hasProgressError && (
            <Alert color="orange">
              Прогресс недоступен.{" "}
              <Button size="compact-xs" variant="subtle" onClick={() => void progress.mutate()}>
                Повторить
              </Button>
            </Alert>
          )}
          {canResetReasons && (
            <Button variant="subtle" size="compact-sm" onClick={handleResetReasons}>
              Перечитать прогресс с начала
            </Button>
          )}
        </header>
      )}
      {shouldShowTasks && (
        <Stack gap="xs">
          {query.isLoading && (
            <Text role="status" size="sm">
              Загружаем задачи…
            </Text>
          )}
          {isEmpty && (
            <div className={styles.empty}>
              <Text fw={600}>{emptyLabel}</Text>
              {isExpanded && (
                <Text size="sm" c="dimmed">
                  {emptyDescription}
                </Text>
              )}
              {canOpenBoard && (
                <Button component={Link} to={boardHref} variant="default" size="sm">
                  {boardLabel}
                </Button>
              )}
            </div>
          )}
          {items.map((task) => (
            <div key={task.id} className={styles.task}>
              <Anchor component={Link} to={task.href} className={styles.taskLink} underline="never">
                <Text component="span" size="xs" c="dimmed" ff="monospace">
                  {task.key}
                </Text>
                <Text component="span" size="sm" fw={550}>
                  {task.label}
                </Text>
                <ArrowUpRight size={15} aria-hidden="true" />
              </Anchor>
              <Badge
                variant="light"
                color={task.color}
                c="var(--mantine-color-text)"
                size="sm"
                title={task.columnTitle}
              >
                {task.columnLabel}
              </Badge>
            </div>
          ))}
          {hasMore && (
            <Button
              variant="subtle"
              loading={query.isValidating}
              onClick={() => void query.setSize(query.size + 1).catch(() => undefined)}
            >
              Ещё задачи
            </Button>
          )}
          {hasTaskError && (
            <Alert color="red">
              Не удалось загрузить задачи.{" "}
              <Button
                variant="subtle"
                onClick={() =>
                  void query
                    .setSize(1)
                    .then(() => query.mutate())
                    .catch(() => undefined)
                }
              >
                Повторить
              </Button>
            </Alert>
          )}
        </Stack>
      )}
    </div>
  );
};
