import { useState, type ReactElement } from "react";
import { Alert, Badge, Button, Group, SimpleGrid, Stack, Text } from "@mantine/core";
import { CloudUpload } from "lucide-react";
import { useGitSync, useRequestGitSync, useGitSyncConflicts } from "domains/git-sync";
import { errorMessage } from "domains/project";
import { gitSyncMessages as m } from "./git-sync.messages";
import styles from "./styles/git-sync.module.css";

/**
 * Показывает реальную Git-доставку независимо от SSE и локальной доступности БД.
 * Неизвестные значения остаются неизвестными; детали не интерпретируют pending как Git ahead.
 *
 * Используется для:
 *  - чтения статуса обмена и наблюдения исходного ручного запроса через Runtime
 */
export function GitSync(): ReactElement {
  const status = useGitSync();
  const request = useRequestGitSync();
  const [opened, setOpened] = useState(false);
  const conflicts = useGitSyncConflicts(opened, status, request.outcome);
  const data = status.data;
  let label: string = m.unknown;
  if (data?.connected === false) {
    label = m.local;
  }
  if (data?.connected === true) {
    label = m.connected;
  }
  if (data?.conflicts.count && data.conflicts.count > 0) {
    label = m.conflicted;
  }
  const error = request.error ?? (status.error ? errorMessage(status.error) : data?.error?.message);
  const unknown = m.unknownValue;
  const conflictColor = data?.conflicts.count ? "orange" : "gray";
  const responsive =
    data?.worker.responsive === null || data?.worker.responsive === undefined
      ? unknown
      : String(data.worker.responsive);
  const freshness = data?.freshness.known === true ? m.known : unknown;
  return (
    <details
      className={styles.root}
      open={opened}
      onToggle={(event) => setOpened(event.currentTarget.open)}
    >
      <summary>
        <CloudUpload size={17} aria-hidden="true" />
        <strong>{m.title}</strong>
        <span role="status">{label}</span>
        <Badge variant="light">
          {m.pending}: {data?.pending.changesets ?? unknown}
        </Badge>
        <Badge color={conflictColor} variant="light">
          {m.conflicts}: {data?.conflicts.count ?? unknown}
        </Badge>
      </summary>
      <Stack gap="sm" className={styles.details}>
        <Text size="sm">{m.explanation}</Text>
        <SimpleGrid cols={{ base: 1, sm: 2, xl: 3 }}>
          <Text size="sm">
            {m.worker}: {data?.worker.actual ?? unknown} · {m.desired}:{" "}
            {data?.worker.desired ?? unknown} · {m.responsive}: {responsive}
          </Text>
          <Text size="sm">
            {m.mode}: {data?.mode ?? unknown} · {m.phase}: {data?.phase ?? unknown}
          </Text>
          <Text size="sm">
            {m.unexported}: {data?.pending.unexported ?? unknown}
          </Text>
          <Text size="sm">
            {m.lastSuccess}: {data?.lastSuccess ?? m.never}
          </Text>
          <Text size="sm">
            {m.freshness}: {freshness} · {data?.freshness.asOf ?? unknown}
          </Text>
          <Text size="sm">
            {m.conflictFreshness}: {data?.conflicts.freshness ?? unknown} ·{" "}
            {data?.conflicts.asOf ?? unknown}
          </Text>
        </SimpleGrid>
        {error && (
          <Alert color="orange" title={m.error}>
            {error}
          </Alert>
        )}
        {request.outcome && (
          <Text size="sm" role="status">
            {m.request}: {request.outcome.requestId} · {request.outcome.state}
          </Text>
        )}
        {request.outcome?.state === "failed" && (
          <Alert color="orange">{request.outcome.error.message}</Alert>
        )}
        {request.outcome?.state === "unknown" && <Alert color="orange">{m.unknownOutcome}</Alert>}
        <Group>
          <Button
            size="xs"
            variant="default"
            onClick={() => void status.mutate()}
            loading={status.isValidating}
          >
            {m.refresh}
          </Button>
          {request.outcome && (
            <Button size="xs" variant="default" onClick={() => void request.refresh()}>
              {m.checkOutcome}
            </Button>
          )}
          <Button
            size="xs"
            disabled={data?.connected !== true}
            loading={request.pending}
            onClick={() => void request.request()}
          >
            {m.now}
          </Button>
        </Group>
        {conflicts.error && <Alert color="orange">{errorMessage(conflicts.error)}</Alert>}
        {conflicts.data?.conflicts.map((conflict) => (
          <Alert key={conflict.id} color="orange" title={conflict.code}>
            {conflict.message}
            <Text size="xs">{conflict.id}</Text>
          </Alert>
        ))}
        {conflicts.data?.blocked.map((blocked) => (
          <Text key={blocked.id} size="sm">
            {m.blocked}: {blocked.message} ({blocked.dependencies.join(", ")})
          </Text>
        ))}
      </Stack>
    </details>
  );
}
