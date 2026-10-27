import { Anchor, Menu, Text, Tooltip } from "@mantine/core";
import { Link } from "react-router-dom";
import clsx from "clsx";
import { isDefined } from "shared/value-predicates";
import type { BreadcrumbLinkProps } from "./types/breadcrumb-link-props.type";
import styles from "./styles/breadcrumb-link.module.css";

/**
 * Показывает доступного родителя или выделенную текущую страницу.
 *
 * Используется для:
 *  - перехода без перезагрузки и раскрытия полного названия при фокусе
 */
export const BreadcrumbLink = (props: BreadcrumbLinkProps) => {
  const { item, isCurrent = false, inMenu = false, className } = props;
  const canNavigate = !isCurrent && isDefined(item.href);
  const current = isCurrent ? "page" : undefined;

  if (inMenu && canNavigate) {
    return (
      <Menu.Item component={Link} to={item.href ?? ""} className={styles.menuItem}>
        {item.label}
      </Menu.Item>
    );
  }

  if (canNavigate) {
    return (
      <Tooltip
        label={item.label}
        multiline
        maw={360}
        openDelay={500}
        events={{ hover: true, focus: true, touch: false }}
      >
        <Anchor
          component={Link}
          to={item.href ?? ""}
          underline="never"
          className={clsx(styles.root, className)}
        >
          {item.label}
        </Anchor>
      </Tooltip>
    );
  }

  return (
    <Tooltip
      label={item.label}
      multiline
      maw={360}
      openDelay={500}
      events={{ hover: true, focus: true, touch: false }}
    >
      <Text
        component="span"
        tabIndex={0}
        aria-current={current}
        className={clsx(styles.root, styles._current, className)}
      >
        {item.label}
      </Text>
    </Tooltip>
  );
};
