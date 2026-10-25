import type { ReactElement } from "react";
import { Navigate, Outlet, useParams } from "react-router-dom";
import {
  Alert,
  Badge,
  Button,
  Container,
  Group,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { ProjectScope, useWorkspace, errorMessage } from "domains/project";
import { serverKey } from "infra/relay-api";
import { StatePanel } from "ui/state-panel";
import { MarkdownLinkProvider } from "ui/markdown-link";
import { RelayMarkdownLink } from "./ui/relay-markdown-link/relay-markdown-link";
import { relayMessages as m } from "./relay.messages";
import { ProjectChoice } from "./ui/project-choice/project-choice";

/**
 * Открывает постоянный ID проекта и сохраняет все регистрации workspace,
 * включая недоступные; смена ID размонтирует запросы и формы прежнего проекта.
 *
 * Используется для:
 *  - выбора независимого проекта без потери недоступных регистраций
 */
export function RelayScreen(): ReactElement {
  const workspace = useWorkspace();
  const { projectId } = useParams();
  const loadingMessage = workspace.error ? errorMessage(workspace.error) : m.loading;
  if (!workspace.data) {
    return (
      <StatePanel
        title={m.connecting}
        isLoading={workspace.isLoading}
        description={loadingMessage}
        action={<Button onClick={() => void workspace.mutate()}>{m.retry}</Button>}
      />
    );
  }
  const context = workspace.data;
  const selected = context.projects.find(
    (project) => project.id === projectId && project.available,
  );
  if (selected?.id) {
    return (
      <ProjectScope
        key={`${serverKey}:${selected.id}`}
        projectId={selected.id}
        actor={context.actor}
        serverKey={serverKey}
      >
        <MarkdownLinkProvider component={RelayMarkdownLink}>
          <Outlet />
        </MarkdownLinkProvider>
      </ProjectScope>
    );
  }
  const onlyProject = context.projects[0];
  if (!projectId && context.mode === "project" && onlyProject?.available && onlyProject.id) {
    return <Navigate to={`/projects/${encodeURIComponent(onlyProject.id)}`} replace />;
  }
  return (
    <Container size="lg" py="xl">
      <Stack gap="xl">
        <Group justify="space-between">
          <Title order={1}>Relay</Title>
          <Badge>{context.mode}</Badge>
        </Group>
        <div>
          <Title order={2}>{m.select}</Title>
          <Text c="dimmed">{m.description}</Text>
        </div>
        {projectId && (
          <Alert color="orange" title={m.unavailable}>
            {m.selectAnother}
          </Alert>
        )}
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
          {context.projects.map((project, index) => (
            <ProjectChoice key={`${project.id}:${project.name}:${index}`} project={project} />
          ))}
        </SimpleGrid>
        <Button
          variant="default"
          onClick={() => void workspace.mutate()}
          loading={workspace.isValidating}
        >
          {m.refresh}
        </Button>
      </Stack>
    </Container>
  );
}
