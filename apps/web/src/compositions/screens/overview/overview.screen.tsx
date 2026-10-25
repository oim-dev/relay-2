import type { ReactElement } from "react";
import { Link } from "react-router-dom";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  Progress,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { TASK_COLUMNS } from "@relay/contracts";
import {
  entityHref,
  entityName,
  errorMessage,
  useEntities,
  useOverview,
  useProject,
} from "domains/project";
import { StatePanel } from "ui/state-panel";
import { MarkdownView } from "ui/markdown-view";
import { overviewMessages as m } from "./overview.messages";
import styles from "./styles/overview.module.css";

/**
 * Показывает текущие Core-агрегаты и bounded предпросмотры рабочих материалов.
 * Числа относятся к snapshot обзора; отдельно загруженные карточки не выдаются за тот же snapshot.
 *
 * Используется для:
 *  - ориентации в проекте по текущим агрегатам и перехода к рабочим материалам
 */
export function OverviewScreen(): ReactElement {
  const { projectId } = useProject();
  const overview = useOverview();
  const product = useEntities("product");
  const plans = useEntities("work-plan");
  const releases = useEntities("release");
  const documents = useEntities("document");
  const boards = useEntities("board");
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const loadingMessage = overview.error ? errorMessage(overview.error) : m.loading;
  if (!overview.data) {
    return (
      <StatePanel
        title={m.title}
        isLoading={overview.isLoading}
        description={loadingMessage}
        action={<Button onClick={() => void overview.mutate()}>{m.refresh}</Button>}
      />
    );
  }
  const data = overview.data;
  const passport = product.data?.items.find((item) => item.kind === "product");
  const previewGroups = [
    { title: m.plans, path: "plans", query: plans },
    { title: m.releases, path: "releases", query: releases },
    { title: m.documents, path: "documents", query: documents },
    { title: m.boards, path: "board", query: boards },
  ];
  const columns = TASK_COLUMNS.map((column) => ({
    id: column,
    label: m.column[column],
    count: data.tasks.columns[column] ?? 0,
    percent: data.tasks.total ? ((data.tasks.columns[column] ?? 0) / data.tasks.total) * 100 : 0,
  }));
  return (
    <div className={styles.root}>
      <div className={styles.stage}>
        <Group justify="space-between" align="flex-start">
          <div>
            <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
              {m.title}
            </Text>
            <Title order={1}>{data.project.data.name}</Title>
            <Text c="dimmed">
              {m.generation}: {data.generation}
            </Text>
          </div>
          <Button
            variant="default"
            loading={overview.isValidating}
            onClick={() => void overview.mutate()}
          >
            {m.refresh}
          </Button>
        </Group>
        {overview.error && <Alert color="orange">{errorMessage(overview.error)}</Alert>}
        <Card withBorder radius="lg" padding="lg">
          <Stack gap="sm">
            <Group justify="space-between">
              <Title order={2}>{passport?.data.name ?? m.product}</Title>
              <Anchor component={Link} to={`${base}/knowledge/product`}>
                {m.openPassport}
              </Anchor>
            </Group>
            {product.error && <Alert color="orange">{errorMessage(product.error)}</Alert>}
            <MarkdownView text={passport?.data.summary ?? ""} emptyText={m.emptyPassport} />
          </Stack>
        </Card>
        <SimpleGrid cols={{ base: 2, sm: 4 }}>
          {[
            { label: m.tasks, count: data.tasks.total, path: "board" },
            { label: m.blocked, count: data.tasks.blocked, path: "board" },
            { label: m.plans, count: data.counts["work-plan"], path: "plans" },
            { label: m.documents, count: data.counts.document, path: "documents" },
          ].map((metric) => (
            <Card
              key={metric.label}
              component={Link}
              to={`${base}/${metric.path}`}
              withBorder
              radius="lg"
            >
              <Text size="sm" c="dimmed">
                {metric.label}
              </Text>
              <Text fz={32} fw={650}>
                {metric.count}
              </Text>
            </Card>
          ))}
        </SimpleGrid>
        <SimpleGrid cols={{ base: 1, md: 2 }}>
          <Card withBorder radius="lg" padding="lg">
            <Stack>
              <Title order={2}>{m.columns}</Title>
              <Text size="sm" c="dimmed">
                {m.columnHint}
              </Text>
              {columns.map((column) => (
                <div key={column.id}>
                  <Group justify="space-between">
                    <Text size="sm">{column.label}</Text>
                    <Text size="sm" fw={600}>
                      {column.count}
                    </Text>
                  </Group>
                  <Progress mt={5} value={column.percent} aria-label={column.label} />
                </div>
              ))}
            </Stack>
          </Card>
          <Card withBorder radius="lg" padding="lg">
            <Stack>
              <Title order={2}>{m.knowledge}</Title>
              {(["feature", "scenario", "application", "implementation"] as const).map((kind) => (
                <Group key={kind} justify="space-between">
                  <Anchor component={Link} to={`${base}/knowledge/${kind}`}>
                    {m.kind[kind]}
                  </Anchor>
                  <Badge variant="light">{data.counts[kind]}</Badge>
                </Group>
              ))}
              <Text size="sm" c="dimmed">
                {m.knowledgeHint}
              </Text>
            </Stack>
          </Card>
        </SimpleGrid>
        <Text size="xs" c="dimmed">
          {m.previewHint}
        </Text>
        <SimpleGrid cols={{ base: 1, md: 2 }}>
          {previewGroups.map((group) => (
            <Card key={group.path} withBorder radius="lg" padding="lg">
              <Stack gap="sm">
                <Group justify="space-between">
                  <Title order={2}>{group.title}</Title>
                  <Anchor component={Link} to={`${base}/${group.path}`}>
                    {m.all}
                  </Anchor>
                </Group>
                {group.query.error && (
                  <Alert color="orange">{errorMessage(group.query.error)}</Alert>
                )}
                {group.query.isLoading && <Text c="dimmed">{m.loading}</Text>}
                {group.query.data?.items.slice(0, 5).map((entity) => (
                  <Group key={entity.id} justify="space-between" wrap="nowrap">
                    <Anchor component={Link} to={entityHref(projectId, entity.id)} lineClamp={2}>
                      {entityName(entity)}
                    </Anchor>
                    <Badge variant="outline">{entity.key}</Badge>
                  </Group>
                ))}
                {group.query.data?.total === 0 && (
                  <Text size="sm" c="dimmed">
                    {m.empty}
                  </Text>
                )}
                {group.query.data && (
                  <Text size="xs" c="dimmed">
                    {m.total}: {group.query.data.total}
                  </Text>
                )}
              </Stack>
            </Card>
          ))}
        </SimpleGrid>
      </div>
    </div>
  );
}
