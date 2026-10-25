import type { ReactElement } from "react";
import { Link } from "react-router-dom";
import { Accordion, Anchor, Badge, Card, Group, List, Stack, Text, Title } from "@mantine/core";
import { entityHref, useProject } from "domains/project";
import { MarkdownView } from "ui/markdown-view";
import type { CheckpointCardProps } from "../../history-form.types";
import { historyMessages as m } from "../../history.messages";

/**
 * Представляет неизменяемый материал и исторические снимки его предметных ссылок.
 *
 * Используется для:
 *  - чтения намерения, прогресса и результата
 *  - восстановления сохранённого контекста продолжения работы
 */
export function CheckpointCard({ checkpoint }: CheckpointCardProps): ReactElement {
  const { projectId } = useProject();
  const data = checkpoint.data;
  const details = [
    { label: m.done, text: data.done },
    { label: m.remaining, text: data.remaining },
    { label: m.nextStep, text: data.nextStep },
    { label: m.checks, text: data.checks },
  ].filter((entry) => entry.text !== null);
  return (
    <Card withBorder id={`checkpoint-${checkpoint.id}`}>
      <Stack gap="sm">
        <Group justify="space-between">
          <Badge variant="light">{m.kinds[data.kind]}</Badge>
          <Text size="xs" c="dimmed">
            {data.actor} · {checkpoint.createdAt}
          </Text>
        </Group>
        <Title order={3} size="h4">
          {data.title}
        </Title>
        {data.summary !== null && <Text>{data.summary}</Text>}
        <MarkdownView text={data.body} compact headingStartLevel={4} />
        <Accordion>
          {details.map((entry) => (
            <Accordion.Item key={entry.label} value={entry.label}>
              <Accordion.Control>{entry.label}</Accordion.Control>
              <Accordion.Panel>
                <MarkdownView text={entry.text ?? ""} compact headingStartLevel={4} />
              </Accordion.Panel>
            </Accordion.Item>
          ))}
        </Accordion>
        <List size="sm">
          {data.references.map((entry) => (
            <List.Item key={entry.id}>
              <Anchor component={Link} to={entityHref(projectId, entry.id)}>
                {entry.key} · {entry.title}
              </Anchor>
            </List.Item>
          ))}
        </List>
        <List size="sm">
          {data.acceptedSessionIds.map((id) => (
            <List.Item key={id}>
              <Anchor component={Link} to={`/projects/${projectId}/history/sessions/${id}`}>
                {m.accepted} · {id}
              </Anchor>
            </List.Item>
          ))}
        </List>
        <Anchor
          component={Link}
          size="sm"
          to={`/projects/${projectId}/history/sessions/${data.sessionId}?checkpoint=${checkpoint.id}`}
        >
          {m.viewSession}
        </Anchor>
      </Stack>
    </Card>
  );
}
