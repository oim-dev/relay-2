import clsx from "clsx";
import { useState } from "react";
import { Alert, Anchor, Button, Group, Stack, Text } from "@mantine/core";
import { GitBranch } from "lucide-react";
import { Link } from "react-router-dom";
import { useRelations, relationAddress } from "domains/relations";
import type { RelationsQuery } from "domains/relations";
import { useProjectId, useProjectBasePath } from "domains/project";
import { isEmptyArray } from "shared/value-predicates";
import { MarkdownView } from "ui/markdown-view";
import type { ProductDependenciesProps } from "./types/product-dependencies-props.type";
import styles from "./styles/product-dependencies.module.css";

/**
 * Показывает прямые зависимости с пояснением и ограниченным продолжением.
 *
 * Используется для:
 *  - чтения зависимостей реализации и её исходного требования
 */
export const ProductDependencies = (props: ProductDependenciesProps) => {
  const { reference, title, className, ...rootAttrs } = props;
  const project = useProjectId();
  const base = useProjectBasePath();
  const [page, setPage] = useState<Pick<RelationsQuery, "offset" | "version">>({ offset: 0 });
  const query = useRelations(project, {
    root: reference,
    type: "depends-on",
    direction: "outgoing",
    depth: 1,
    limit: 5,
    ...page,
  });
  const dependencyItems = (query.data?.edges ?? [])
    .filter((edge) => relationAddress(edge.from) === reference || edge.from.id === reference)
    .map((edge) => {
      const target = query.data?.endpoints.find(
        (node) => relationAddress(node.ref) === relationAddress(edge.to),
      );
      return {
        id: edge.id,
        title: target?.title ?? edge.to.id,
        key: target?.key ?? edge.to.id,
        href: `${base}/relations?root=${encodeURIComponent(relationAddress(edge.to))}`,
        description: edge.description,
        hasDescription: edge.description !== "",
      };
    });
  const isEmpty = query.data?.totalEdges === 0 && query.error === undefined;
  const hasError = query.error !== undefined;
  const isLoading = query.data === undefined && !hasError;
  const hasMore = query.data?.nextOffset !== null && query.data?.nextOffset !== undefined;
  const canGoBack = (page.offset ?? 0) > 0;
  const isPageEmpty = !isEmpty && isEmptyArray(dependencyItems) && !isLoading && !hasError;
  const contextHref = `${base}/relations?root=${encodeURIComponent(reference)}`;
  return (
    <section {...rootAttrs} className={clsx(styles.root, className)}>
      <Group gap="xs" mb="md">
        <GitBranch size={17} aria-hidden="true" />
        <Text component="h2" size="sm" fw={650}>
          {title}
        </Text>
      </Group>
      {isLoading && (
        <Text size="sm" role="status">
          Загружаем зависимости…
        </Text>
      )}
      {hasError && (
        <Alert color="orange">
          Не удалось прочитать зависимости.{" "}
          <Button
            size="compact-xs"
            variant="subtle"
            onClick={() => {
              setPage({ offset: 0 });
              void query.mutate();
            }}
          >
            Повторить
          </Button>
        </Alert>
      )}
      {isEmpty && (
        <Text size="sm" c="dimmed">
          Прямые зависимости не заданы.
        </Text>
      )}
      {isPageEmpty && (
        <Text size="sm" c="dimmed">
          На этой странице нет дополнительных зависимостей.
        </Text>
      )}
      <Stack gap="md">
        {dependencyItems.map((entry) => (
          <div key={entry.id}>
            <Text size="xs" c="dimmed" ff="monospace">
              {entry.key}
            </Text>
            <Anchor component={Link} to={entry.href} size="sm">
              {entry.title}
            </Anchor>
            {entry.hasDescription && <MarkdownView text={entry.description} />}
          </div>
        ))}
      </Stack>
      {hasMore && (
        <Button
          mt="sm"
          variant="subtle"
          size="compact-xs"
          onClick={() =>
            setPage({ offset: query.data?.nextOffset ?? 0, version: query.data?.version })
          }
        >
          Следующие зависимости
        </Button>
      )}
      {canGoBack && (
        <Button mt="sm" variant="subtle" size="compact-xs" onClick={() => setPage({ offset: 0 })}>
          В начало списка
        </Button>
      )}
      <Anchor component={Link} to={contextHref} size="xs" mt="md" display="block">
        Открыть все связи
      </Anchor>
    </section>
  );
};
