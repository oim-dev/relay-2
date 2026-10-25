import type { ReactElement } from "react";
import { Link } from "react-router-dom";
import { Anchor, Badge, Card, Group, Stack, Text } from "@mantine/core";
import { useProject } from "domains/project";
import type { SessionTreeProps } from "../../history-form.types";
import { historyMessages as m } from "../../history.messages";

/**
 * Представляет серверное дерево поручений с явными ссылками происхождения.
 *
 * Используется для:
 *  - перехода между корневой работой и её потомками
 *  - чтения состояний поручений в серверном порядке обхода
 */
export function SessionTree({ sessions }: SessionTreeProps): ReactElement {
  const { projectId } = useProject();
  const parents = new Map(sessions.map((session) => [session.id, session.data.title]));
  return (
    <Stack gap="sm">
      {sessions.map((session) => (
        <Card key={session.id} withBorder>
          <Group justify="space-between">
            <Anchor component={Link} to={`/projects/${projectId}/history/sessions/${session.id}`}>
              {session.data.title}
            </Anchor>
            <Badge variant="light">{m.statuses[session.data.status]}</Badge>
          </Group>
          {session.data.parentSessionId !== null && (
            <Text size="sm" c="dimmed">
              {m.parent}:{" "}
              <Anchor
                component={Link}
                size="sm"
                to={`/projects/${projectId}/history/sessions/${session.data.parentSessionId}`}
              >
                {parents.get(session.data.parentSessionId) ?? session.data.parentSessionId}
              </Anchor>
            </Text>
          )}
        </Card>
      ))}
    </Stack>
  );
}
