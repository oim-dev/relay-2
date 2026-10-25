import { useState, type ReactElement } from "react";
import { Link, useParams } from "react-router-dom";
import { Accordion, Alert, Badge, Button, Group, Stack, Text, Title } from "@mantine/core";
import type { NamedCommand } from "@relay/contracts";
import { stageCommand } from "domains/planning";
import {
  errorMessage,
  useCommandDraft,
  useDraft,
  useEntity,
  useProject,
  useRead,
} from "domains/project";
import { MarkdownView } from "ui/markdown-view";
import { EntityDocuments } from "compositions/widgets/entity-documents";
import { PlanForm } from "../plan-form/plan-form";
import { StageForm } from "../stage-form/stage-form";
import { StageCard } from "../stage-card/stage-card";
import { PlanningProgress } from "../planning-progress/planning-progress";
import { PlanningTransition } from "../planning-transition/planning-transition";
import { planningMessages as m } from "../../planning.messages";
import type { PlanningTransitionEditor } from "../../planning-form.types";

/**
 * Собирает карточку плана с серверным прогрессом, этапами и явными переходами.
 *
 * Используется для:
 *  - управления содержанием и составом плана
 *  - завершения работы с фиксацией результата
 */
export function PlanScreen(): ReactElement {
  const { ref } = useParams();
  const { projectId } = useProject();
  const query = useEntity(ref);
  const progress = useRead("planProgress", ref === undefined ? undefined : { ref });
  const operation = useCommandDraft(`stage-action:${ref}`);
  const operationSource = useDraft<NamedCommand | undefined>(
    `stage-action-source:${ref}`,
    undefined,
  );
  const [editing, setEditing] = useState(false);
  const [creatingStage, setCreatingStage] = useState(false);
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
  const plan = query.data.entity;
  if (plan.kind !== "work-plan") {
    return <Alert color="red">{m.wrongKind}</Alert>;
  }
  const source = {
    entity: plan,
    ...(query.data.expectedVersion === undefined
      ? {}
      : { expectedVersion: query.data.expectedVersion }),
  };
  const isMutable = plan.data.status === "draft" || plan.data.status === "active";
  const hasStages = plan.data.stages.some(Boolean);
  const isLocked = operation.pending || operation.uncertain;
  const transitionEditor = transition.value;
  /**
   * Повторное открытие сохраняет прежний source даже после SSE или возврата на маршрут.
   */
  function openTransition(): void {
    transition.setValue({ source: transition.value?.source ?? source, opened: true });
  }
  /**
   * Сворачивает диалог, оставляя независимую от статуса точку проверки receipt.
   */
  function closeTransition(): void {
    if (transition.value !== null) {
      transition.setValue({ ...transition.value, opened: false });
    }
  }
  /**
   * Владелец команды остаётся смонтированным после удаления этапа и сохраняет повторяемый запрос.
   */
  async function applyStage(request: NamedCommand): Promise<void> {
    operationSource.setValue(request);
    if ((await operation.submit(request)) !== undefined) {
      operationSource.reset();
    }
  }
  return (
    <Stack>
      <Button component={Link} to={`/projects/${projectId}/plans`} variant="subtle" w="fit-content">
        {m.backPlans}
      </Button>
      <Group justify="space-between">
        <Stack gap="xs">
          <Group>
            <Text c="dimmed">{plan.key}</Text>
            <Badge variant="light">{m.planStatus[plan.data.status]}</Badge>
          </Group>
          <Title order={1}>{plan.data.title}</Title>
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
      <Text>{plan.data.summary}</Text>
      <MarkdownView text={plan.data.goal} />
      <PlanningProgress
        progress={progress.data}
        error={progress.error}
        onRefresh={() => void progress.mutate()}
      />
      <Accordion variant="separated">
        <Accordion.Item value="details">
          <Accordion.Control>{m.description}</Accordion.Control>
          <Accordion.Panel>
            <Stack>
              <Title order={3} size="h5">
                {m.rationale}
              </Title>
              <MarkdownView text={plan.data.rationale} />
              <Title order={3} size="h5">
                {m.boundaries}
              </Title>
              <MarkdownView text={plan.data.boundaries} />
              <Title order={3} size="h5">
                {m.expectedResult}
              </Title>
              <MarkdownView text={plan.data.expectedResult} />
              <Text fw={600}>{m.participants}</Text>
              <Text>{plan.data.participants.join(", ")}</Text>
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
      <EntityDocuments target={{ kind: "work-plan", id: plan.id }} />
      <Group justify="space-between">
        <Title order={2}>{m.stageTitle}</Title>
        {isMutable && <Button onClick={() => setCreatingStage(true)}>{m.addStage}</Button>}
      </Group>
      {!hasStages && <Text c="dimmed">{m.noStages}</Text>}
      {operation.error !== undefined && <Alert color="red">{operation.error}</Alert>}
      {operation.uncertain && (
        <Alert color="orange">
          {m.uncertain}
          <Button
            loading={operation.pending}
            onClick={() => {
              if (operationSource.value !== undefined) {
                void applyStage(operationSource.value);
              }
            }}
          >
            {m.retry}
          </Button>
        </Alert>
      )}
      {plan.data.stages.map((stage) => (
        <StageCard
          key={stage.id}
          source={source}
          stage={stage}
          percent={progress.data?.stages.find((entry) => entry.id === stage.id)?.counts.percent}
          locked={isLocked}
          onChange={(change) => void applyStage(stageCommand(source, change))}
        />
      ))}
      {plan.data.result !== "" && (
        <>
          <Title order={2}>{m.result}</Title>
          <MarkdownView text={plan.data.result} />
        </>
      )}
      {editing && <PlanForm key={plan.id} source={source} onClose={() => setEditing(false)} />}
      {creatingStage && (
        <StageForm key={plan.id} source={source} onClose={() => setCreatingStage(false)} />
      )}
    </Stack>
  );
}
