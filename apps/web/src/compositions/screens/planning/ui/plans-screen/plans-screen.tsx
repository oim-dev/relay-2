import { useState, type ReactElement } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { PLAN_STATUSES } from "@relay/contracts";
import { errorMessage, useEntityPages, useProject } from "domains/project";
import { PlanForm } from "../plan-form/plan-form";
import { planningMessages as m } from "../../planning.messages";

/**
 * Показывает постраничный каталог планов и создание нового плана.
 *
 * Используется для:
 *  - поиска по серверному каталогу и фильтрации статусов
 *  - перехода к этапам выбранного плана
 */
export function PlansScreen(): ReactElement {
  const { projectId } = useProject();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const query = params.get("q") ?? "";
  const status = params.get("status") ?? "";
  const page = useEntityPages("work-plan", {
    ...(query.trim() === "" ? {} : { q: query }),
    ...(status === "" ? {} : { status }),
  });
  const plans = page.items.filter((entry) => entry.kind === "work-plan");
  const isEmpty = !page.loading && page.error === undefined && !plans.some(Boolean);
  /**
   * Сохраняет фильтр в URL для прямого открытия и истории браузера.
   */
  function filter(name: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value === "") {
      next.delete(name);
    } else {
      next.set(name, value);
    }
    setParams(next, { replace: true });
  }
  return (
    <Stack>
      <Group justify="space-between">
        <Title order={1}>{m.plans}</Title>
        <Button onClick={() => setCreating(true)}>{m.newPlan}</Button>
      </Group>
      <Group grow>
        <TextInput
          label={m.search}
          value={query}
          onChange={(event) => filter("q", event.currentTarget.value)}
        />
        <Select
          label={m.status}
          placeholder={m.all}
          clearable
          value={status || null}
          data={PLAN_STATUSES.map((value) => ({ value, label: m.planStatus[value] }))}
          onChange={(value) => filter("status", value ?? "")}
        />
      </Group>
      {page.error !== undefined && (
        <Alert color="red" title={m.readFailure}>
          {errorMessage(page.error)}
          <Button variant="subtle" onClick={page.reload}>
            {m.refresh}
          </Button>
        </Alert>
      )}
      {page.loading && <Text role="status">{m.loading}</Text>}
      {isEmpty && <Text c="dimmed">{m.empty}</Text>}
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        {plans.map((plan) => (
          <Card key={plan.id} withBorder>
            <Stack gap="xs">
              <Group justify="space-between">
                <Text size="sm" c="dimmed">
                  {plan.key}
                </Text>
                <Badge variant="light">{m.planStatus[plan.data.status]}</Badge>
              </Group>
              <Title order={2} size="h3">
                <Link to={`/projects/${projectId}/plans/${plan.id}`}>{plan.data.title}</Link>
              </Title>
              <Text size="sm" lineClamp={3}>
                {plan.data.summary}
              </Text>
            </Stack>
          </Card>
        ))}
      </SimpleGrid>
      {page.hasMore && (
        <Button variant="default" loading={page.loading} onClick={page.loadMore}>
          {m.more}
        </Button>
      )}
      {creating && <PlanForm onClose={() => setCreating(false)} />}
    </Stack>
  );
}
