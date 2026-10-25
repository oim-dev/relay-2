import { Alert, Anchor, Badge, Button, Group, Loader, Stack, Title } from "@mantine/core";
import type { ReactElement } from "react";
import { Link, useParams } from "react-router-dom";
import { errorMessage, useEntity, useProject } from "domains/project";
import { taskColumnLabels, taskMessages, type TaskSnapshot } from "domains/tasks";
import { EntityDocuments } from "compositions/widgets/entity-documents";
import { taskScreenMessages as messages } from "./config/task-screen.messages";
import { TaskContent } from "./ui/task-content/task-content";
import { TaskMove } from "./ui/task-move/task-move";
import { TaskCriteria } from "./ui/task-criteria/task-criteria";
import { TaskRelations } from "./ui/task-relations/task-relations";
import { TaskComments } from "./ui/task-comments/task-comments";
import { TaskProgress } from "./ui/task-progress/task-progress";
import styles from "./styles/task.module.css";

/**
 * Собирает самостоятельную карточку задачи из текущих контрактов Core.
 *
 * Используется для:
 *  - редактирования содержания, критериев, размещения и связей
 *  - чтения серверной готовности и независимого журнала комментариев
 */
export const TaskScreen = (): ReactElement => {
  const { ref } = useParams();
  const { projectId } = useProject();
  const query = useEntity(ref);
  const entity = query.data?.entity;
  if (entity === undefined) {
    if (query.error !== undefined) {
      return (
        <Alert color="red" title={messages.loadError}>
          {errorMessage(query.error)}
          <Button variant="subtle" onClick={() => void query.mutate()}>
            {messages.reload}
          </Button>
        </Alert>
      );
    }
    return <Loader aria-label={messages.loading} />;
  }
  if (entity.kind !== "task") {
    return <Alert color="red">{messages.missing}</Alert>;
  }
  const snapshot: TaskSnapshot = {
    task: entity,
    ...(query.data?.expectedVersion === undefined
      ? {}
      : { expectedVersion: query.data.expectedVersion }),
  };
  return (
    <section className={styles.root} key={entity.id}>
      <Anchor
        component={Link}
        to={`/projects/${encodeURIComponent(projectId)}/board?board=${encodeURIComponent(entity.data.boardId)}`}
      >
        {messages.board}
      </Anchor>
      <Group>
        <Badge variant="light">{entity.key}</Badge>
        <Badge color="gray" variant="light">
          {taskColumnLabels[entity.data.column]}
        </Badge>
      </Group>
      <Title order={1} style={{ overflowWrap: "anywhere" }}>
        {entity.data.title || taskMessages.unnamed}
      </Title>
      {query.error !== undefined && (
        <Alert color="orange" title={messages.loadError}>
          {errorMessage(query.error)}
        </Alert>
      )}
      <div className={styles.workspace}>
        <Stack gap="xl">
          <TaskContent snapshot={snapshot} />
          <TaskCriteria snapshot={snapshot} />
          <EntityDocuments target={{ kind: "task", id: entity.id }} />
          <TaskComments snapshot={snapshot} />
        </Stack>
        <Stack gap="xl">
          <TaskMove snapshot={snapshot} />
          <TaskProgress snapshot={snapshot} />
          <TaskRelations snapshot={snapshot} />
        </Stack>
      </div>
    </section>
  );
};
