import { useState, type ReactElement } from "react";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  Modal,
  Select,
  Skeleton,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { DOCUMENT_TARGET_KINDS } from "@relay/contracts";
import { entityHref, errorMessage, useEntity, useEntityPages, useProject } from "domains/project";
import { EntityPicker } from "domains/knowledge";
import { documentKindLabel, documentKindOptions, documentStatusLabel } from "domains/documents";
import { DocumentEditor } from "./ui/document-editor/document-editor";
import { SectionEditor } from "./ui/section-editor/section-editor";
import { messages, targetKindLabels } from "./config/documents.messages";
import styles from "./styles/documents.module.css";

const views = [
  { value: "all", label: messages.all },
  { value: "draft", label: messages.drafts },
  { value: "pinned", label: messages.pinned },
  { value: "none", label: messages.noSection },
  { value: "archived", label: messages.archive },
];
const targetOptions = DOCUMENT_TARGET_KINDS.map((value) => ({
  value,
  label: targetKindLabels[value],
}));

/**
 * Представляет библиотеку с серверными фильтрами, разделами и продолжением списка.
 *
 * Используется для:
 *  - поиска документов, создания материалов и управления разделами проекта
 */
export const DocumentsScreen = (): ReactElement => {
  const { projectId } = useProject();
  const project = useEntity(projectId);
  const [params, setParams] = useSearchParams();
  const [search] = useDebouncedValue(params.get("q") ?? "", 200);
  const [creating, setCreating] = useState(false);
  const [editingSections, setEditingSections] = useState(false);
  const navigate = useNavigate();
  const section = params.get("section");
  const view = params.get("view") ?? "all";
  const kind = params.get("documentKind");
  const sort = params.get("sort") === "title" ? "title" : "updated";
  const filters: Record<string, string> = {
    ...(search === "" ? {} : { q: search }),
    sort,
    archived: view === "archived" ? "true" : "false",
  };
  if (kind !== null) {
    filters.documentKind = kind;
  }
  if (section !== null) {
    filters.sectionId = section;
  } else if (view === "none") {
    filters.section = "none";
  }
  if (view === "draft") {
    filters.documentStatus = "draft";
  }
  if (view === "pinned") {
    filters.pinned = "true";
  }
  const target = params.get("target");
  const targetKind =
    DOCUMENT_TARGET_KINDS.find((value) => value === params.get("targetKind")) ?? "feature";
  if (target !== null) {
    filters.target = target;
  }
  const page = useEntityPages("document", filters);
  const sectionItems =
    project.data?.entity.kind === "project"
      ? (project.data.entity.data.documentSections ?? [])
      : [];
  const sectionOptions = sectionItems.map((item) => ({ value: item.id, label: item.name }));
  const hasError = page.error !== undefined && page.error !== null;
  const hasProjectError = project.error !== undefined;
  const isEmpty = !page.loading && !hasError && page.total === 0;
  const canEditSections = project.data?.entity.kind === "project";
  const navigation = views.map((item) => ({
    ...item,
    variant: view === item.value && section === null ? "light" : "subtle",
  }));

  /**
   * Сохраняет фильтры в URL без локальной фильтрации неполной страницы.
   */
  function filter(name: string, value: string | null): void {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (value === null || value === "") {
          next.delete(name);
        } else {
          next.set(name, value);
        }
        return next;
      },
      { replace: true },
    );
  }

  /**
   * Системный вид начинает независимую выборку без старого фильтра раздела.
   */
  function selectView(value: string): void {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set("view", value);
      next.delete("section");
      return next;
    });
  }
  return (
    <Stack className={styles.root}>
      <Group justify="space-between">
        <div>
          <Title order={1}>{messages.title}</Title>
          <Text c="dimmed">{messages.description}</Text>
        </div>
        <Button onClick={() => setCreating(true)}>{messages.create}</Button>
      </Group>
      <div className={styles.library}>
        <aside aria-label={messages.sections} className={styles.navigation}>
          <Stack gap="xs">
            {navigation.map((item) => (
              <Button
                key={item.value}
                variant={item.variant}
                justify="start"
                onClick={() => selectView(item.value)}
              >
                {item.label}
              </Button>
            ))}
            <Select
              label={messages.section}
              placeholder={messages.all}
              data={sectionOptions}
              value={section}
              onChange={(value) => filter("section", value)}
              clearable
            />
            <Button
              variant="default"
              onClick={() => setEditingSections(true)}
              disabled={!canEditSections}
            >
              {messages.manageSections}
            </Button>
            {hasProjectError && (
              <Alert color="orange">
                {errorMessage(project.error)}
                <Button variant="subtle" onClick={() => void project.mutate()}>
                  {messages.retry}
                </Button>
              </Alert>
            )}
          </Stack>
        </aside>
        <Stack className={styles.content}>
          <TextInput
            label={messages.search}
            value={params.get("q") ?? ""}
            onChange={(event) => filter("q", event.currentTarget.value)}
          />
          <Group grow align="end">
            <Select
              label={messages.kind}
              data={documentKindOptions}
              value={kind}
              onChange={(value) => filter("documentKind", value)}
              clearable
            />
            <Select
              label={messages.sort}
              data={[
                { value: "updated", label: messages.updated },
                { value: "title", label: messages.byTitle },
              ]}
              value={sort}
              onChange={(value) => filter("sort", value)}
              allowDeselect={false}
            />
          </Group>
          <Group grow align="start">
            <Select
              label={messages.targetKind}
              data={targetOptions}
              value={targetKind}
              allowDeselect={false}
              onChange={(value) =>
                setParams(
                  (previous) => {
                    const next = new URLSearchParams(previous);
                    next.set("targetKind", value ?? "feature");
                    next.delete("target");
                    return next;
                  },
                  { replace: true },
                )
              }
            />
            <EntityPicker
              key={targetKind}
              kind={targetKind}
              label={messages.target}
              value={target}
              onChange={(value) => filter("target", value)}
            />
          </Group>
          <Button variant="subtle" size="compact-xs" onClick={() => setParams({})}>
            {messages.clear}
          </Button>
          {hasError && (
            <Alert color="orange">
              {errorMessage(page.error)}
              <Button variant="subtle" onClick={page.reload}>
                {messages.refresh}
              </Button>
            </Alert>
          )}
          {page.loading && <Skeleton height={100} />}
          {isEmpty && <Text c="dimmed">{messages.empty}</Text>}
          {page.items.map((entity) => {
            if (entity.kind !== "document") {
              return null;
            }
            const data = entity.data;
            return (
              <Card key={entity.id} withBorder radius="md" className={styles.document}>
                <Group gap="xs">
                  <Badge variant="light">{documentKindLabel(data.documentKind)}</Badge>
                  <Badge variant="outline">{documentStatusLabel(data.documentStatus)}</Badge>
                  {data.pinned && <Badge color="yellow">{messages.pinned}</Badge>}
                </Group>
                <Anchor component={Link} to={entityHref(projectId, entity.id)} fw={600} mt="sm">
                  {data.name}
                </Anchor>
                <Text size="sm" c="dimmed" lineClamp={3}>
                  {data.summary}
                </Text>
                <Text size="xs" c="dimmed" mt="xs">
                  {entity.key}
                </Text>
              </Card>
            );
          })}
          <Text size="xs" c="dimmed">
            {page.items.length} / {page.total ?? "—"}
          </Text>
          {page.hasMore && (
            <Button variant="default" onClick={page.loadMore} loading={page.loading}>
              {messages.more}
            </Button>
          )}
        </Stack>
      </div>
      <Modal opened={creating} onClose={() => setCreating(false)} title={messages.create} size="xl">
        {creating && (
          <DocumentEditor
            source={null}
            sectionId={section}
            onClose={() => setCreating(false)}
            onSaved={(id) => {
              setCreating(false);
              navigate(entityHref(projectId, id));
            }}
          />
        )}
      </Modal>
      <Modal
        opened={editingSections}
        onClose={() => setEditingSections(false)}
        title={messages.manageSections}
        size="lg"
      >
        {editingSections && canEditSections && project.data !== undefined && (
          <SectionEditor
            source={project.data}
            onClose={() => setEditingSections(false)}
            onSaved={() => {
              setEditingSections(false);
              void project.mutate();
              page.reload();
            }}
          />
        )}
      </Modal>
    </Stack>
  );
};
