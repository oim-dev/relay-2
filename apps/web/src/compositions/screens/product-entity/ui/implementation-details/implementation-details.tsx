import clsx from "clsx";
import { Alert, Anchor, Button, Group, Stack, Text, ThemeIcon } from "@mantine/core";
import { BookOpen, Layers, Puzzle, Route } from "lucide-react";
import { Link } from "react-router-dom";
import { useProductEntity, ProductKey, productError } from "domains/product";
import { useProjectId, useProjectBasePath } from "domains/project";
import { ProductTasks } from "compositions/widgets/product-tasks";
import { MarkdownView } from "ui/markdown-view";
import { ProductDependencies } from "compositions/widgets/product-dependencies";
import type { ImplementationDetailsProps } from "./types/implementation-details-props.type";
import styles from "./styles/implementation-details.module.css";

/**
 * Объединяет исходное требование, вклад приложения и подтверждающую работу.
 *
 * Используется для:
 *  - чтения полного описания и зависимостей реализации без скрытых разделов
 */
export const ImplementationDetails = (props: ImplementationDetailsProps) => {
  const {
    implementationId,
    targetId,
    title,
    description,
    applicationId,
    applicationName,
    applicationHref,
    sourceHref,
    className,
    ...rootAttrs
  } = props;
  const projectId = useProjectId();
  const projectBase = useProjectBasePath();
  const source = useProductEntity(projectId, targetId);
  const application = useProductEntity(projectId, applicationId);
  const applicationFields = application.data?.fields;
  const boardHref =
    applicationFields?.kind === "application"
      ? `${projectBase}/boards/${applicationFields.slug}`
      : undefined;
  const hasBoard = boardHref !== undefined;
  const sourceFields = source.data?.fields;
  const hasSource = sourceFields?.kind === "feature" || sourceFields?.kind === "scenario";
  const isScenario = sourceFields?.kind === "scenario";
  const SourceIcon = isScenario ? Route : Puzzle;
  const sourceLabel = isScenario ? "Описание сценария" : "Описание фичи";
  const sourceColor = isScenario ? "teal" : "violet";
  const sourceDescription = hasSource ? sourceFields.description : "";
  const sourceTitle = hasSource ? sourceFields.name : "Исходное требование";
  const hasSourceError = source.error !== undefined;
  const isSourceLoading = !hasSource && !hasSourceError;
  return (
    <div {...rootAttrs} className={clsx(styles.root, className)}>
      <nav className={styles.navigation} aria-label="Разделы реализации">
        <Anchor href="#requirement" size="sm">
          Описание
        </Anchor>
        <Anchor href="#contribution" size="sm">
          Вклад приложения
        </Anchor>
        <Anchor href="#implementation-tasks" size="sm">
          Задачи реализации
        </Anchor>
        <Anchor href="#implementation-dependencies" size="sm">
          Зависимости
        </Anchor>
      </nav>
      <div className={styles.content}>
        <section
          id="requirement"
          tabIndex={-1}
          className={styles.document}
          aria-label={sourceLabel}
        >
          <Group gap="sm" mb="lg">
            <ThemeIcon color={sourceColor} variant="light" size="lg" radius="md">
              <SourceIcon size={20} aria-hidden="true" />
            </ThemeIcon>
            <div>
              <Text component="h2" size="lg" fw={650}>
                {sourceLabel}
              </Text>
              <ProductKey value={source.data?.key} />
            </div>
          </Group>
          {isSourceLoading && (
            <Text role="status" c="dimmed">
              Загружаем полное требование…
            </Text>
          )}
          {hasSourceError && (
            <Alert color="orange" title="Не удалось обновить требование">
              {productError(source.error)}{" "}
              <Button variant="subtle" size="xs" onClick={() => void source.mutate()}>
                Повторить
              </Button>
            </Alert>
          )}
          {hasSource && <MarkdownView text={sourceDescription} />}
        </section>
        <section
          id="contribution"
          tabIndex={-1}
          className={styles.document}
          aria-label="Вклад приложения"
        >
          <Group gap="sm" mb="lg">
            <ThemeIcon variant="light" color="blue" size="lg" radius="md">
              <Layers size={20} aria-hidden="true" />
            </ThemeIcon>
            <Text component="h2" size="lg" fw={650}>
              Вклад приложения
            </Text>
          </Group>
          <Text fw={600} mb="md">
            {title}
          </Text>
          <MarkdownView text={description} />
        </section>
        <ProductTasks
          id="implementation-tasks"
          tabIndex={-1}
          targetId={implementationId}
          boardHref={boardHref}
          scope="application"
        />
      </div>
      <aside
        id="implementation-dependencies"
        tabIndex={-1}
        className={styles.sidebar}
        aria-label="Контекст и зависимости"
      >
        <section className={styles.context}>
          <Group gap="xs">
            <BookOpen size={17} aria-hidden="true" />
            <Text component="h2" size="sm" fw={650}>
              Контекст реализации
            </Text>
          </Group>
          <Stack gap={4} mt="md">
            <Text size="xs" c="dimmed">
              Приложение
            </Text>
            <Anchor component={Link} to={applicationHref} size="sm">
              {applicationName}
            </Anchor>
          </Stack>
          <Stack gap={4} mt="md">
            <Text size="xs" c="dimmed">
              Исходное требование
            </Text>
            <Anchor component={Link} to={sourceHref ?? applicationHref} size="sm">
              {sourceTitle}
            </Anchor>
          </Stack>
          {hasBoard && (
            <Button component={Link} to={boardHref} variant="default" size="xs" mt="lg" fullWidth>
              Открыть доску приложения
            </Button>
          )}
        </section>
        <ProductDependencies
          reference={`implementation:${implementationId}`}
          title="Зависимости реализации"
        />
        <ProductDependencies reference={targetId} title="Зависимости требования" />
      </aside>
    </div>
  );
};
