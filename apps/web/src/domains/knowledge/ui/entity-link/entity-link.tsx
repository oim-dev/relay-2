import type { ReactElement } from "react";
import { Anchor } from "@mantine/core";
import { Link } from "react-router-dom";
import { entityHref, entityName, useEntity, useProject } from "domains/project";
import type { EntityLinkProps } from "./types/entity-link-props.type";

/**
 * Показывает доступное имя адресной связи и сохраняет переход при отказе чтения.
 *
 * Используется для:
 *  - переходов между документом, требованием и приложением
 */
export const EntityLink = (props: EntityLinkProps): ReactElement => {
  const { projectId } = useProject();
  const query = useEntity(props.id);
  const entity = query.data?.entity;
  const label = entity === undefined ? props.id : `${entity.key} · ${entityName(entity)}`;
  return (
    <Anchor
      component={Link}
      to={entityHref(projectId, props.id)}
      style={{ overflowWrap: "anywhere" }}
    >
      {label}
    </Anchor>
  );
};
