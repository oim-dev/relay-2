import { useState, type ReactElement } from "react";
import { Link, useParams } from "react-router-dom";
import { Alert, Badge, Button, Card, Group, Stack, Text, Title } from "@mantine/core";
import { errorMessage, useDraft, useEntity, useProject, useRead } from "domains/project";
import { MarkdownView } from "ui/markdown-view";
import { EntityDocuments } from "compositions/widgets/entity-documents";
import { ReleaseForm } from "../release-form/release-form";
import { PlanningProgress } from "../planning-progress/planning-progress";
import { PlanningTransition } from "../planning-transition/planning-transition";
import { planningMessages as m } from "../../planning.messages";
import type { PlanningTransitionEditor } from "../../planning-form.types";

/**
 * Показывает выпуск, его реальный состав и текущую серверную готовность.
 *
 * Используется для:
 *  - подготовки и перепланирования релиза
 *  - явной публикации готового состава
 */
export function ReleaseScreen(): ReactElement {
  const { ref } = useParams();
  const { projectId } = useProject();
  const query = useEntity(ref);
  const progress = useRead("releaseProgress", ref === undefined ? undefined : { ref });
  const plans = useRead("releasePlans", ref === undefined ? undefined : { ref });
  const [editing, setEditing] = useState(false);
  const transition = useDraft<PlanningTransitionEditor | null>(
    `planning-transition-editor:${ref}`,
    null,
  );
  if (query.error !== undefined) {
    return (
      <Alert color="red">
        {errorMessage(query.error)}
        <Button onClick={() => void query.mutate()}>{m.refresh}</Button>
      </Alert>
    );
  }
  if (query.data === undefined) {
    return <Text role="status">{m.loading}</Text>;
  }
  const release = query.data.entity;
  if (release.kind !== "release") {
    return <Alert color="red">{m.wrongKind}</Alert>;
  }
  const source = {
    entity: release,
    ...(query.data.expectedVersion === undefined
      ? {}
      : { expectedVersion: query.data.expectedVersion }),
  };
  const isMutable = release.data.status !== "released";
  const transitionEditor = transition.value;
  /**
   * Открывает текущий выбор либо фиксирует первый источник нового перехода релиза.
   */
  function openTransition(): void {
    transition.setValue({ source: transition.value?.source ?? source, opened: true });
  }
  /**
   * Сохраняет исходную операцию публикации после сворачивания и смены серверного статуса.
   */
  function closeTransition(): void {
    if (transition.value !== null) {
      transition.setValue({ ...transition.value, opened: false });
    }
  }
  return (
    <Stack>
      <Button
        component={Link}
        to={`/projects/${projectId}/releases`}
        variant="subtle"
        w="fit-content"
      >
        {m.backReleases}
      </Button>
      <Group justify="space-between">
        <Stack gap="xs">
          <Group>
            <Text c="dimmed">
              {release.key} · {release.data.version}
            </Text>
            <Badge variant="light">{m.releaseStatus[release.data.status]}</Badge>
          </Group>
          <Title order={1}>{release.data.title}</Title>
        </Stack>
        {isMutable && (
          <Group>
            <Button variant="default" onClick={() => setEditing(true)}>
              {m.edit}
            </Button>
            <Button onClick={openTransition}>{m.changeStatus}</Button>
          </Group>
        )}
      </Group>
      {transitionEditor !== null && (
        <PlanningTransition
          key={transitionEditor.source.entity.id}
          {...transitionEditor}
          onClose={closeTransition}
          onOpen={openTransition}
          onComplete={transition.reset}
        />
      )}
      <Text>{release.data.summary}</Text>
      <Text c="dimmed">{release.data.plannedFor}</Text>
      <MarkdownView text={release.data.description} />
      <EntityDocuments target={{ kind: "release", id: release.id }} />
      <PlanningProgress
        progress={progress.data}
        error={progress.error}
        onRefresh={() => void progress.mutate()}
      />
      <Title order={2}>{m.composition}</Title>
      {plans.error !== undefined && (
        <Alert color="red">
          {errorMessage(plans.error)}
          <Button onClick={() => void plans.mutate()}>{m.refresh}</Button>
        </Alert>
      )}
      {plans.isLoading && <Text role="status">{m.loading}</Text>}
      {plans.data?.items.map((plan) => (
        <Card key={plan.id} withBorder>
          <Group justify="space-between">
            <Link to={`/projects/${projectId}/plans/${plan.id}`}>
              {plan.key} · {plan.data.title}
            </Link>
            <Badge variant="light">{m.planStatus[plan.data.status]}</Badge>
          </Group>
          <Text size="sm">{plan.data.summary}</Text>
        </Card>
      ))}
      {release.data.releasedAt !== null && (
        <Text c="dimmed">
          {release.data.releasedAt} · {release.data.releasedBy}
        </Text>
      )}
      {editing && (
        <ReleaseForm key={release.id} source={source} onClose={() => setEditing(false)} />
      )}
    </Stack>
  );
}
