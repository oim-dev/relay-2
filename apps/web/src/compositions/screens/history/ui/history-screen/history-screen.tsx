import type { ReactElement } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Alert,
  Button,
  Group,
  Modal,
  Select,
  Stack,
  Tabs,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { historySessionStatuses } from "@relay/contracts";
import { errorMessage, useDraft, useRead } from "domains/project";
import { SessionForm } from "../session-form/session-form";
import { CheckpointCard } from "../checkpoint-card/checkpoint-card";
import { HistorySessionList } from "../history-session-list/history-session-list";
import { HistoryMaterialList } from "../history-material-list/history-material-list";
import { historyMessages as m } from "../../history.messages";

/**
 * Связывает серверные страницы истории с фильтрами и адресным чтением выбранного материала.
 *
 * Используется для:
 *  - поиска сессии и начала новой работы
 *  - просмотра хронологии материалов и адресного checkpoint
 */
export function HistoryScreen(): ReactElement {
  const [params, setParams] = useSearchParams();
  const creation = useDraft<boolean | null>("history-start-editor", null);
  const tab = params.get("tab") ?? "sessions";
  const status = params.get("status") ?? "";
  const selectedStatus = historySessionStatuses.find((value) => value === status);
  const isInvalidStatus = status !== "" && selectedStatus === undefined;
  const canReadSessions = !isInvalidStatus;
  const query = params.get("q") ?? "";
  const selected = params.get("checkpoint");
  const checkpoint = useRead(
    "historyCheckpoint",
    selected === null ? undefined : { ref: selected },
  );
  /**
   * Сохраняет фильтры и выбранный материал в URL; смену поколения страниц ведёт доменный хук.
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
        <Title order={1}>{m.history}</Title>
        <Button onClick={() => creation.setValue(true)}>{m.start}</Button>
      </Group>
      {creation.value !== null && (
        <SessionForm
          action="start"
          opened={creation.value}
          onClose={() => creation.setValue(false)}
          onOpen={() => creation.setValue(true)}
          onComplete={creation.reset}
        />
      )}
      <Tabs
        value={tab}
        onChange={(value) => filter("tab", value ?? "sessions")}
        keepMounted={false}
      >
        <Tabs.List>
          <Tabs.Tab value="sessions">{m.sessions}</Tabs.Tab>
          <Tabs.Tab value="checkpoints">{m.checkpoints}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="sessions" pt="md">
          <Stack>
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
                data={historySessionStatuses.map((value) => ({ value, label: m.statuses[value] }))}
                value={selectedStatus ?? null}
                onChange={(value) => filter("status", value ?? "")}
              />
            </Group>
            {isInvalidStatus && <Alert color="red">{m.invalidStatus}</Alert>}
            {canReadSessions && <HistorySessionList query={query} status={selectedStatus} />}
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="checkpoints" pt="md">
          <Stack>
            <Title order={2}>{m.checkpoints}</Title>
            <HistoryMaterialList onOpen={(id) => filter("checkpoint", id)} />
          </Stack>
        </Tabs.Panel>
      </Tabs>
      <Modal
        closeButtonProps={{ "aria-label": m.close }}
        attributes={{ header: { role: "presentation" } }}
        opened={selected !== null}
        title={m.material}
        onClose={() => filter("checkpoint", "")}
        size="xl"
      >
        {checkpoint.error !== undefined && (
          <Alert color="red">
            {errorMessage(checkpoint.error)}
            <Button variant="subtle" onClick={() => void checkpoint.mutate()}>
              {m.refresh}
            </Button>
          </Alert>
        )}
        {checkpoint.isLoading && <Text role="status">{m.loading}</Text>}
        {checkpoint.data !== undefined && <CheckpointCard checkpoint={checkpoint.data} />}
      </Modal>
    </Stack>
  );
}
