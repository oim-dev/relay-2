import type { ReactElement } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  Accordion,
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Stack,
  Tabs,
  Text,
  Title,
} from "@mantine/core";
import { errorMessage, useDraft, useEntity, useProject, useRead } from "domains/project";
import { MarkdownView } from "ui/markdown-view";
import { CheckpointCard } from "../checkpoint-card/checkpoint-card";
import { CheckpointForm } from "../checkpoint-form/checkpoint-form";
import { SessionForm } from "../session-form/session-form";
import { SessionTree } from "../session-tree/session-tree";
import type { HistoryEditor, HistoryEditorState } from "../../history-editor.types";
import { historyMessages as m } from "../../history.messages";

/**
 * Показывает согласованный контекст сессии и управляет её предметной историей.
 *
 * Используется для:
 *  - продолжения работы по открытым намерениям и дочерним поручениям
 *  - записи прогресса, результатов и переходов ответственности
 */
export function SessionScreen(): ReactElement {
  const { ref } = useParams();
  const { projectId, actor } = useProject();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "context";
  const selectedId = params.get("checkpoint");
  const query = useEntity(ref);
  const context = useRead("historyContext", ref === undefined ? undefined : { ref });
  const tree = useRead("historyTree", ref === undefined || tab !== "tree" ? undefined : { ref });
  const selected = useRead(
    "historyCheckpoint",
    selectedId === null ? undefined : { ref: selectedId },
  );
  const editorState = useDraft<HistoryEditorState | null>(`history-editor:${ref}`, null);
  const editor = editorState.value?.editor;
  const hasEditor = editorState.value !== null;
  const editorOpened = editorState.value?.opened ?? false;
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
  const session = query.data.entity;
  if (session.kind !== "work-session") {
    return <Alert color="red">{m.wrongKind}</Alert>;
  }
  const source = {
    entity: session,
    ...(query.data.expectedVersion === undefined
      ? {}
      : { expectedVersion: query.data.expectedVersion }),
  };
  const currentRun = session.data.runs.find((run) => run.id === session.data.currentRunId);
  const isOwner = currentRun?.actor === actor && currentRun.state === "active";
  const isOpen = session.data.status === "open";
  const isPending = session.data.status === "pending";
  const isPaused = session.data.status === "paused";
  const canTakeover = isOpen && !isOwner;
  const canCancelWithoutRun = isPending || isPaused;
  const hasIntents = context.data?.intents.some(Boolean) === true;
  const hasMaterials = context.data?.checkpoints.some(Boolean) === true;
  const sessionEditor = editor?.kind === "session" ? editor : undefined;
  const checkpointEditor = editor?.kind === "checkpoint" ? editor : undefined;
  /**
   * Фиксирует единственный исходный редактор, не заменяя незавершённую операцию новым действием.
   */
  function setEditor(next: HistoryEditor): void {
    if (editorState.value === null) {
      editorState.setValue({ editor: next, opened: true });
    }
  }
  /**
   * Меняет только видимость сохранённого редактора; guards и действие остаются исходными.
   */
  function showEditor(opened: boolean): void {
    if (editorState.value !== null) {
      editorState.setValue({ ...editorState.value, opened });
    }
  }
  /**
   * Сохраняет выбранную проекцию сессии в URL для Back/Forward и прямого перехода.
   */
  function selectTab(value: string | null): void {
    const next = new URLSearchParams(params);
    next.set("tab", value ?? "context");
    setParams(next);
  }
  return (
    <Stack>
      <Button
        component={Link}
        to={`/projects/${projectId}/history`}
        variant="subtle"
        w="fit-content"
      >
        {m.back}
      </Button>
      <Group justify="space-between">
        <Title order={1}>{session.data.title}</Title>
        <Badge variant="light">{m.statuses[session.data.status]}</Badge>
      </Group>
      <MarkdownView text={session.data.description ?? ""} />
      <Text size="sm" c="dimmed">
        {m.owner}: {currentRun?.actor ?? m.noOwner}
      </Text>
      <Group>
        {isPending && (
          <Button
            disabled={hasEditor}
            onClick={() => setEditor({ kind: "session", action: "attach", source })}
          >
            {m.attach}
          </Button>
        )}
        {isPaused && (
          <Button
            disabled={hasEditor}
            onClick={() => setEditor({ kind: "session", action: "resume", source })}
          >
            {m.resume}
          </Button>
        )}
        {canTakeover && (
          <Button
            disabled={hasEditor}
            onClick={() => setEditor({ kind: "session", action: "takeover", source })}
          >
            {m.takeover}
          </Button>
        )}
        {isOwner && (
          <>
            <Button
              disabled={hasEditor}
              onClick={() => setEditor({ kind: "checkpoint", action: "open", source })}
            >
              {m.openIntent}
            </Button>
            <Button
              variant="default"
              disabled={hasEditor}
              onClick={() => setEditor({ kind: "session", action: "pause", source })}
            >
              {m.pause}
            </Button>
            <Button
              variant="default"
              disabled={hasEditor}
              onClick={() => setEditor({ kind: "session", action: "complete", source })}
            >
              {m.complete}
            </Button>
            <Button
              color="red"
              variant="subtle"
              disabled={hasEditor}
              onClick={() => setEditor({ kind: "session", action: "cancel", source })}
            >
              {m.cancel}
            </Button>
          </>
        )}
        {canCancelWithoutRun && (
          <Button
            color="red"
            variant="subtle"
            disabled={hasEditor}
            onClick={() => setEditor({ kind: "session", action: "cancel", source })}
          >
            {m.cancel}
          </Button>
        )}
      </Group>
      {sessionEditor !== undefined && (
        <SessionForm
          key={`${sessionEditor.action}:${sessionEditor.intent?.id ?? ""}`}
          {...sessionEditor}
          opened={editorOpened}
          onClose={() => showEditor(false)}
          onOpen={() => showEditor(true)}
          onComplete={editorState.reset}
        />
      )}
      {checkpointEditor !== undefined && (
        <CheckpointForm
          key={`${checkpointEditor.action}:${checkpointEditor.intent?.id ?? ""}`}
          {...checkpointEditor}
          opened={editorOpened}
          children={context.data?.children ?? []}
          onClose={() => showEditor(false)}
          onOpen={() => showEditor(true)}
          onComplete={editorState.reset}
        />
      )}
      {session.data.result !== null && <MarkdownView text={session.data.result} />}
      {selected.error !== undefined && <Alert color="red">{errorMessage(selected.error)}</Alert>}
      {selected.data !== undefined && (
        <>
          <Title order={2}>{m.material}</Title>
          <CheckpointCard checkpoint={selected.data} />
        </>
      )}
      <Tabs value={tab} onChange={selectTab}>
        <Tabs.List>
          <Tabs.Tab value="context">{m.context}</Tabs.Tab>
          <Tabs.Tab value="checkpoints">{m.checkpoints}</Tabs.Tab>
          <Tabs.Tab value="tree">{m.tree}</Tabs.Tab>
          <Tabs.Tab value="runs">{m.runs}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="context" pt="md">
          <Stack>
            {context.error !== undefined && (
              <Alert color="red">
                {errorMessage(context.error)}
                <Button onClick={() => void context.mutate()}>{m.refresh}</Button>
              </Alert>
            )}
            {context.isLoading && <Text role="status">{m.loading}</Text>}
            <Title order={2}>{m.intents}</Title>
            {!hasIntents && <Text c="dimmed">{m.noIntents}</Text>}
            {context.data?.intents.map((intent) => (
              <Card key={intent.id} withBorder>
                <Stack>
                  <CheckpointCard checkpoint={intent} />
                  {isOwner && (
                    <Group>
                      <Button
                        variant="default"
                        disabled={hasEditor}
                        onClick={() =>
                          setEditor({ kind: "checkpoint", action: "save", source, intent })
                        }
                      >
                        {m.saveProgress}
                      </Button>
                      <Button
                        variant="default"
                        disabled={hasEditor}
                        onClick={() =>
                          setEditor({ kind: "checkpoint", action: "complete", source, intent })
                        }
                      >
                        {m.completeIntent}
                      </Button>
                      <Button
                        color="red"
                        variant="subtle"
                        disabled={hasEditor}
                        onClick={() =>
                          setEditor({ kind: "checkpoint", action: "cancel", source, intent })
                        }
                      >
                        {m.cancelIntent}
                      </Button>
                      <Button
                        variant="subtle"
                        disabled={hasEditor}
                        onClick={() =>
                          setEditor({ kind: "session", action: "fork", source, intent })
                        }
                      >
                        {m.fork}
                      </Button>
                    </Group>
                  )}
                </Stack>
              </Card>
            ))}
            <Title order={2}>{m.children}</Title>
            <SessionTree sessions={context.data?.children ?? []} />
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="checkpoints" pt="md">
          <Stack>
            <Title order={2}>{m.checkpoints}</Title>
            <Text c="dimmed" size="sm">
              {m.immutable}
            </Text>
            {context.error !== undefined && (
              <Alert color="red">{errorMessage(context.error)}</Alert>
            )}
            {!hasMaterials && <Text>{m.noMaterials}</Text>}
            {context.data?.checkpoints.map((entry) => (
              <CheckpointCard key={entry.id} checkpoint={entry} />
            ))}
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="tree" pt="md">
          <Stack>
            {tree.error !== undefined && (
              <Alert color="red">
                {errorMessage(tree.error)}
                <Button onClick={() => void tree.mutate()}>{m.refresh}</Button>
              </Alert>
            )}
            {tree.isLoading && <Text role="status">{m.loading}</Text>}
            <SessionTree sessions={tree.data ?? []} />
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="runs" pt="md">
          <Accordion variant="separated">
            {session.data.runs.map((run) => (
              <Accordion.Item key={run.id} value={run.id}>
                <Accordion.Control>
                  {run.actor} · {m.runStates[run.state]}
                </Accordion.Control>
                <Accordion.Panel>
                  <Stack gap="xs">
                    <Text size="sm">
                      {run.startedAt} · {run.endedAt}
                    </Text>
                    <Text size="sm" c="dimmed">
                      {run.client} · {run.sourceSessionId}
                    </Text>
                    <MarkdownView text={run.reason ?? ""} compact />
                    <MarkdownView text={run.endReason ?? ""} compact />
                    <Text size="sm">
                      {run.operator?.name} {run.operator?.email}
                    </Text>
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>
            ))}
          </Accordion>
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
