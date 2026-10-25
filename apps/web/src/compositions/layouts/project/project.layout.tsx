import { useState, type ReactElement } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { ActionIcon, Anchor, Drawer, Group, Select, Text, Tooltip } from "@mantine/core";
import { ClipboardList, Layers3, Menu, Moon, Sun } from "lucide-react";
import {
  useProject,
  useProjectEvents,
  useWorkspace,
  projectSelectionOptions,
  projectSelectionValue,
} from "domains/project";
import { useThemeColorScheme } from "ui/themes";
import { GitSync } from "compositions/widgets/git-sync";
import { ProjectNavigation } from "./ui/project-navigation";
import { projectMessages as m } from "./project.messages";
import styles from "./styles/project.module.css";

/**
 * Сохраняет навигацию оригинального Web, отдельные индикаторы SSE/Git и область
 * выбранного проекта. Смена URL размонтирует форму, сохраняя её отдельный draft.
 *
 * Используется для:
 *  - выбора проекта по постоянному ID с отображением всех доступных workspace-алиасов
 *  - размещения навигации, рабочей области и состояния обмена
 */
export function ProjectLayout(): ReactElement {
  const { projectId } = useProject();
  const workspace = useWorkspace();
  const connection = useProjectEvents();
  const navigate = useNavigate();
  const location = useLocation();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const { colorScheme, setColorScheme } = useThemeColorScheme();
  const projectItems = projectSelectionOptions(workspace.data?.projects ?? []);
  const selectItems = projectItems.map(({ value, label, disabled }) => ({
    value,
    label,
    disabled,
  }));
  const current = projectItems.find((item) => item.projectId === projectId);
  const projectName = current?.label ?? m.project;
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const themeDark = colorScheme === "dark";
  const ThemeIcon = themeDark ? Sun : Moon;
  return (
    <div className={styles.root}>
      <a className={styles.skipLink} href="#project-content">
        {m.skip}
      </a>
      <header className={styles.header}>
        <Group gap="sm" wrap="nowrap" className={styles.identity}>
          <ActionIcon
            className={styles.menuToggle}
            variant="subtle"
            color="gray"
            aria-label={m.openNavigation}
            aria-expanded={navigationOpen}
            aria-haspopup="dialog"
            onClick={() => setNavigationOpen(true)}
          >
            <Menu size={20} />
          </ActionIcon>
          <Layers3 size={22} className={styles.brandIcon} aria-hidden="true" />
          <Anchor component={Link} to="/" className={styles.brand}>
            Relay
          </Anchor>
          <span className={styles.divider}>/</span>
          <Text className={styles.projectName} fw={600} size="sm" lineClamp={1} title={projectName}>
            {projectName}
          </Text>
          {workspace.data?.mode === "workspace" && (
            <Select
              aria-label={m.selectProject}
              size="xs"
              data={selectItems}
              value={projectSelectionValue(projectId)}
              allowDeselect={false}
              searchable
              onChange={(value) => {
                const selected = projectItems.find((item) => item.value === value);
                if (selected !== undefined && !selected.disabled && selected.projectId !== null) {
                  navigate(`/projects/${encodeURIComponent(selected.projectId)}`);
                }
              }}
              className={styles.selector}
              comboboxProps={{ width: 260, position: "bottom-start" }}
            />
          )}
        </Group>
        <Group gap="sm" wrap="nowrap" className={styles.actions}>
          <Tooltip label={m.connection[connection]}>
            <span className={styles.connection} data-state={connection} role="status">
              <span className={styles.dot} />
              <span className={styles.connectionText}>{m.connection[connection]}</span>
            </span>
          </Tooltip>
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label={m.theme}
            onClick={() => setColorScheme(themeDark ? "light" : "dark")}
          >
            <ThemeIcon size={17} />
          </ActionIcon>
        </Group>
      </header>
      <div className={styles.workspace}>
        <aside className={styles.sidebar}>
          <div className={styles.sectionLabel}>{m.project}</div>
          <ProjectNavigation basePath={base} />
          <div className={styles.sidebarFooter}>
            <ClipboardList size={16} />
            <Text size="xs" c="dimmed">
              {m.memory}
            </Text>
          </div>
        </aside>
        <main id="project-content" className={styles.content}>
          <GitSync />
          <div className={styles.page}>
            <Outlet key={location.pathname} />
          </div>
        </main>
      </div>
      <Drawer
        opened={navigationOpen}
        onClose={() => setNavigationOpen(false)}
        position="left"
        size="min(20rem, calc(100vw - 2rem))"
        title={m.navigation}
        closeButtonProps={{ "aria-label": m.closeNavigation }}
        classNames={{ content: styles.drawer, header: styles.drawerHeader }}
      >
        <ProjectNavigation basePath={base} onNavigate={() => setNavigationOpen(false)} />
      </Drawer>
    </div>
  );
}
