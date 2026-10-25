import { Anchor, Stack, Text } from "@mantine/core";
import type { ReactElement } from "react";
import { Link } from "react-router-dom";
import { entityHref, entityName, useEntity, useProject } from "domains/project";
import { taskMessages } from "../../config/tasks.messages";
import type { EntityReferenceProps } from "./types/entity-reference-props.type";

/**
 * Показывает заголовок связанной сущности и прямую ссылку по ID.
 *
 * Используется для:
 *  - перехода по междосочным связям и блокерам
 */
export const EntityReference = ({ id }: EntityReferenceProps): ReactElement => {
  const { projectId } = useProject();
  const query = useEntity(id);
  const entity = query.data?.entity;
  const label = entity === undefined ? id : `${entity.key} · ${entityName(entity)}`;
  return (
    <Stack gap={2} style={{ minWidth: 0 }}>
      <Anchor component={Link} to={entityHref(projectId, id)} style={{ overflowWrap: "anywhere" }}>
        {label}
      </Anchor>
      {query.error !== undefined && (
        <Text size="xs" c="red">
          {taskMessages.referenceError}
        </Text>
      )}
    </Stack>
  );
};
