import clsx from "clsx";
import type { ReactElement } from "react";
import { Divider, NavLink } from "@mantine/core";
import { NavLink as RouterNavLink } from "react-router-dom";
import { NAVIGATION } from "./config/navigation";
import type { ProjectNavigationProps } from "./types/project-navigation-props.type";
import styles from "./styles/project-navigation.module.css";

/**
 * Предоставляет одинаковые ссылки и активный маршрут постоянному сайдбару и Drawer.
 */
export function ProjectNavigation(props: ProjectNavigationProps): ReactElement {
  const { basePath, onNavigate, className, ...attrs } = props;
  return (
    <nav {...attrs} className={clsx(styles.root, className)} aria-label="Разделы проекта">
      {NAVIGATION.map((entry) => (
        <div key={entry.path}>
          {entry.path === "documents" && <Divider my="xs" />}
          <NavLink
            component={RouterNavLink}
            end
            to={`${basePath}${entry.path ? `/${entry.path}` : ""}`}
            label={entry.label}
            leftSection={<entry.Icon size={17} aria-hidden="true" />}
            className={styles.link}
            {...(onNavigate ? { onClick: onNavigate } : {})}
          />
        </div>
      ))}
    </nav>
  );
}
