import { useState, type ReactElement } from "react";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  Modal,
  Select,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useDebouncedValue } from "@mantine/hooks";
import { entityHref, entityName, errorMessage, useEntityPages, useProject } from "domains/project";
import {
  catalogKind,
  implementationLabel,
  implementationActivityLabel,
  implementationOptions,
  knowledgeLabels,
  EntityLink,
  isCatalogEntity,
} from "domains/knowledge";
import { CreateKnowledge } from "./ui/create-knowledge/create-knowledge";
import { messages } from "./config/knowledge-screen.messages";
import styles from "./styles/knowledge.module.css";

/**
 * Собирает каталог знаний с серверными фильтрами и согласованным продолжением.
 *
 * Используется для:
 *  - поиска требований и реализаций
 *  - создания карточек с переходом к сохранённому результату
 */
export const KnowledgeScreen = (): ReactElement => {
  const { kind: routeKind } = useParams();
  const kind = catalogKind(routeKind);
  const { projectId } = useProject();
  const [params, setParams] = useSearchParams();
  const [search] = useDebouncedValue(params.get("q") ?? "", 200);
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const filters: Record<string, string> = {
    sort: "updated",
    ...(search === "" ? {} : { q: search }),
  };
  if (kind === "implementation") {
    for (const key of ["active", "status", "target", "application"] as const) {
      const value = params.get(key);
      if (value !== null && value !== "") {
        filters[key] = value;
      }
    }
  }
  const page = useEntityPages(kind ?? "feature", filters);
  const canCreate = kind !== undefined && kind !== "product";
  const isImplementation = kind === "implementation";
  const hasError = page.error !== undefined && page.error !== null;
  const isEmpty = !page.loading && !hasError && page.total === 0;
  const contextId = params.get("target") ?? params.get("application");
  const navigation = Object.entries(knowledgeLabels).map(([value, label]) => ({
    value,
    label,
    variant: value === kind ? "filled" : "default",
  }));
  const cards = page.items.filter(isCatalogEntity).map((entity) => ({
    id: entity.id,
    key: entity.key,
    name: entityName(entity),
    href: entityHref(projectId, entity.id),
    summary: entity.kind === "implementation" ? undefined : entity.data.summary,
    status: entity.kind === "implementation" ? implementationLabel(entity.data.status) : null,
    activity:
      entity.kind === "implementation" ? implementationActivityLabel(entity.data.active) : null,
  }));

  /**
   * Обновляет адресный фильтр и тем самым начинает новое поколение страниц.
   */
  function filter(name: string, value: string | null): void {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (value === null || value === "") {
          next.delete(name);
        } else {
          next.set(name, value);
        }
        return next;
      },
      { replace: true },
    );
  }
  if (kind === undefined) {
    return <Alert color="orange">{messages.invalidKind}</Alert>;
  }
  return (
    <Stack className={styles.root}>
      <Group justify="space-between">
        <div>
          <Title order={1}>{knowledgeLabels[kind]}</Title>
          <Text c="dimmed">{messages.description}</Text>
        </div>
        {canCreate && <Button onClick={() => setCreating(true)}>{messages.create}</Button>}
      </Group>
      <Group gap="xs">
        {navigation.map(({ value, label, variant }) => (
          <Button
            key={value}
            component={Link}
            to={`/projects/${projectId}/knowledge/${value}`}
            variant={variant}
            size="compact-sm"
          >
            {label}
          </Button>
        ))}
      </Group>
      <Group align="end" grow>
        <TextInput
          label={messages.search}
          value={params.get("q") ?? ""}
          onChange={(event) => filter("q", event.currentTarget.value)}
        />
        {isImplementation && (
          <>
            <Select
              label={messages.status}
              data={implementationOptions}
              value={params.get("status")}
              onChange={(value) => filter("status", value)}
              clearable
            />
            <Select
              label={messages.activeFilter}
              data={[
                { value: "true", label: messages.activeOnly },
                { value: "false", label: messages.inactiveOnly },
              ]}
              value={params.get("active")}
              onChange={(value) => filter("active", value)}
              clearable
            />
          </>
        )}
      </Group>
      {contextId !== null && (
        <Group>
          <Text size="sm">{messages.targetFilter}</Text>
          <EntityLink id={contextId} />
          <Button
            variant="subtle"
            size="compact-xs"
            onClick={() =>
              setParams((previous) => {
                const next = new URLSearchParams(previous);
                next.delete("target");
                next.delete("application");
                return next;
              })
            }
          >
            {messages.clearContext}
          </Button>
        </Group>
      )}
      {hasError && (
        <Alert color="orange">
          {errorMessage(page.error)}
          <Button variant="subtle" onClick={page.reload}>
            {messages.retry}
          </Button>
        </Alert>
      )}
      {page.loading && <Skeleton height={80} />}
      {isEmpty && <Text c="dimmed">{messages.empty}</Text>}
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
        {cards.map((card) => (
          <Card key={card.id} withBorder radius="md" className={styles.card}>
            <Text size="xs" c="dimmed">
              {card.key}
            </Text>
            <Anchor component={Link} to={card.href} fw={600}>
              {card.name}
            </Anchor>
            {card.status !== null && (
              <Group gap="xs" mt="sm">
                <Badge variant="light">{card.status}</Badge>
                <Badge variant="outline">{card.activity}</Badge>
              </Group>
            )}
            {card.summary !== undefined && (
              <Text size="sm" c="dimmed" lineClamp={3} mt="xs">
                {card.summary}
              </Text>
            )}
          </Card>
        ))}
      </SimpleGrid>
      <Text size="xs" c="dimmed">
        {page.items.length} / {page.total ?? "—"}
      </Text>
      {page.hasMore && (
        <Button variant="default" onClick={page.loadMore} loading={page.loading}>
          {messages.more}
        </Button>
      )}
      <Modal opened={creating} onClose={() => setCreating(false)} title={messages.create} size="lg">
        {creating && (
          <CreateKnowledge
            key={kind}
            kind={kind}
            onClose={() => setCreating(false)}
            onSaved={(id) => {
              setCreating(false);
              navigate(entityHref(projectId, id));
            }}
          />
        )}
      </Modal>
    </Stack>
  );
};
