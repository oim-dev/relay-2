import { useEffect } from "react";
import { Outlet, useLocation, useMatch, useNavigate } from "react-router-dom";
import { Badge, Button, Group, Select, Text } from "@mantine/core";
import { useWorkspace, resolveWorkspaceProject } from "domains/workspace";
import { ProjectScope } from "domains/project";
import { StatePanel } from "ui/state-panel";
import { MarkdownLinkProvider } from "ui/markdown-link";
import { PageBreadcrumbs } from "compositions/widgets/page-breadcrumbs";
import { RelayMarkdownLink } from "./ui/relay-markdown-link/relay-markdown-link";
import styles from "./styles/relay.module.css";

/**
 * Открывает один проект или связывает workspace с выбором проекта в URL.
 *
 * Используется для:
 *  - переключения независимых досок и восстановления прямых ссылок
 */
export const RelayScreen = () => {
  const workspace = useWorkspace();
  const navigate = useNavigate();
  const location = useLocation();
  const match = useMatch("/projects/:project/*");
  const selectedId = match?.params.project;
  const workspaceData = workspace.data;
  const projectItems = workspaceData?.projects ?? [];
  const projectData = resolveWorkspaceProject(workspaceData, selectedId);
  const canonicalAddress = projectData?.id;
  const resolvedId = projectData?.id;
  useEffect(() => {
    if (resolvedId === undefined || selectedId === undefined || canonicalAddress === undefined)
      return;
    if (selectedId === canonicalAddress) return;
    const suffix = location.pathname.replace(/^\/projects\/[^/]+/, "");
    navigate(
      `/projects/${encodeURIComponent(canonicalAddress)}${suffix}${location.search}${location.hash}`,
      {
        replace: true,
        state: location.state,
      },
    );
  }, [
    resolvedId,
    selectedId,
    canonicalAddress,
    location.pathname,
    location.search,
    location.hash,
    location.state,
    navigate,
  ]);
  const isWorkspace = workspaceData?.mode === "workspace";
  const canOpenProject = projectData !== undefined && projectData.available;
  const selectItems = [
    ...new Map(
      projectItems.map((project) => [
        project.id,
        {
          value: project.id,
          label: project.name,
          disabled: !project.available,
        },
      ]),
    ).values(),
  ];
  const defaultProject = workspaceData?.defaultProject;
  useEffect(() => {
    if (workspaceData?.mode === "local" && defaultProject && selectedId === undefined) {
      navigate(
        `/projects/${encodeURIComponent(defaultProject)}${location.pathname}${location.search}${location.hash}`,
        { replace: true, state: location.state },
      );
    }
  }, [
    workspaceData?.mode,
    defaultProject,
    selectedId,
    navigate,
    location.pathname,
    location.search,
    location.hash,
    location.state,
  ]);

  if (workspaceData === undefined) {
    return (
      <main>
        <PageBreadcrumbs
          items={[
            { id: "relay", label: "Relay", href: "/" },
            { id: "connection", label: "Подключение" },
          ]}
        />
        <StatePanel
          title="Подключение к Relay"
          description="Запустите relay-server и проверьте подключение."
          isLoading={workspace.isLoading}
          action={<Button onClick={() => void workspace.mutate()}>Повторить</Button>}
        />
      </main>
    );
  }

  const stateTitle = selectedId === undefined ? "Выберите проект" : "Проект недоступен";
  const stateDescription =
    projectData?.error ??
    "Проекты добавляются командой relay workspace project add <имя> <каталог>.";
  return (
    <div className={styles.root}>
      {isWorkspace && !canOpenProject && (
        <Group
          component="nav"
          aria-label="Проекты Relay"
          className={styles.selector}
          justify="space-between"
        >
          <Group>
            <Text fw={700}>Relay</Text>
            <Badge variant="light">workspace</Badge>
          </Group>
          <Select
            aria-label="Выбрать проект"
            placeholder="Выберите проект"
            data={selectItems}
            value={selectedId ?? null}
            searchable
            allowDeselect={false}
            onChange={(projectId) => {
              if (projectId !== null) navigate(`/projects/${encodeURIComponent(projectId)}/`);
            }}
          />
        </Group>
      )}
      {canOpenProject && (
        <ProjectScope key={projectData.id} projectId={projectData.id}>
          <MarkdownLinkProvider component={RelayMarkdownLink}>
            <Outlet />
          </MarkdownLinkProvider>
        </ProjectScope>
      )}
      {!canOpenProject && (
        <main>
          <PageBreadcrumbs
            items={[
              { id: "relay", label: "Relay", href: "/" },
              { id: "selection", label: stateTitle },
            ]}
          />
          <StatePanel title={stateTitle} description={stateDescription} />
        </main>
      )}
    </div>
  );
};
