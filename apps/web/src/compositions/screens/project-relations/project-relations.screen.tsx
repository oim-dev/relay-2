import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  NumberInput,
  SegmentedControl,
  Skeleton,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from "@mantine/core";
import { ArrowLeft, GitFork, Plus, RefreshCw, Search } from "lucide-react";
import { useProjectId, useProjectBasePath } from "domains/project";
import { useEntitySummary } from "domains/entities";
import {
  relationAddress,
  relationError,
  saveRelations,
  useRelations,
  isRelationWriteUncertain,
  acknowledgeRelations,
} from "domains/relations";
import { EntityBrowser } from "./ui/entity-browser/entity-browser";
import { RelationEditor } from "./ui/relation-editor/relation-editor";
import { RelationExplorer } from "./ui/relation-explorer/relation-explorer";
import { getEntityPresentation } from "./config/relation-presentation";
import styles from "./styles/project-relations.module.css";
import { relationDraftMessages } from "./config/relation-draft.messages";
import {
  claimRelationDraft,
  relationDraftKey,
  readRelationRemoval,
  saveRelationRemoval,
} from "./helpers/relation-draft";
import type { RelationDraftLease, RelationRemovalDraft } from "./types/relation-draft.types";

/**
 * Даёт человеку адресное рабочее место для исследования связей проекта.
 *
 * Используется для:
 *  - выбора сущности и последовательного восстановления её окружения
 *  - добавления недостающих отношений с сохранением контекста
 */
export const ProjectRelationsScreen = (): ReactElement => {
  const projectId = useProjectId();
  return <ProjectRelationsScope key={projectId} projectId={projectId} />;
};

/**
 * Изолирует форму, подтверждение отзыва и поздние ответы при A → B → A.
 */
const ProjectRelationsScope = ({ projectId }: { projectId: string }): ReactElement => {
  const base = useProjectBasePath();
  const screenRef = useRef<HTMLElement>(null);
  const [params, setParams] = useSearchParams();
  const [initialRemoval] = useState(() => readRelationRemoval(projectId));
  const request = useRef<RelationRemovalDraft | null>(initialRemoval);
  const screenLease = useRef<RelationDraftLease | null>(null);
  useEffect(() => {
    const lease = claimRelationDraft(relationDraftKey(projectId, "screen-removal"));
    screenLease.current = lease;
    return () => {
      lease.dispose();
      if (screenLease.current === lease) {
        screenLease.current = null;
      }
    };
  }, [projectId]);
  const root = params.get("root") ?? request.current?.root ?? null;
  const selection = useEntitySummary(projectId, root);
  const selectedNode = selection.data;
  const selectedAddress = selectedNode ? relationAddress(selectedNode.ref) : root;
  const mode = params.get("view") === "chain" ? "chain" : "direct";
  const depth = Math.trunc(Math.min(100, Math.max(2, Number(params.get("depth")) || 3)));
  const [page, setPage] = useState({
    scope: "",
    offset: 0,
    version: undefined as string | undefined,
  });
  const scope = `${projectId}:${root}:${mode}:${depth}`;
  const currentPage = page.scope === scope ? page : { offset: 0, version: undefined };
  const [isEditorOpen, setEditorOpen] = useState(false);
  const [editorData, setEditorData] = useState<{
    root: string;
    version: string;
    key: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(
    initialRemoval ? relationDraftMessages.pendingRemoval : null,
  );
  const [notice, setNotice] = useState("");
  const query = useRelations(
    projectId,
    root === null
      ? null
      : {
          root,
          depth: mode === "direct" ? 1 : depth,
          profile: "all",
          limit: 30,
          offset: currentPage.offset,
          version: currentPage.version,
        },
  );
  const graph = query.data;
  const version = graph?.version ?? "";
  const hasSelection = root !== null;
  const hasNoSelection = !hasSelection;
  const isChain = mode === "chain";
  const presentation = getEntityPresentation(selectedNode?.ref.kind ?? "project");
  const hasError = error !== null || query.error !== undefined || selection.error !== undefined;
  const errorMessage = error ?? query.error?.message ?? selection.error?.message;
  const canEdit = version !== "" && !hasError && selectedNode !== undefined;
  const hasNotice = notice !== "";
  const hasGraph = graph !== undefined && selectedAddress !== null && !hasError;
  const hasEditor = editorData !== null;
  const hasBoundary = isChain && graph?.depthLimited === true;
  const isLoading = query.isLoading || selection.isLoading;
  const selectedTitle =
    selectedNode?.title ??
    (selection.error === undefined ? "Загружаем сущность…" : "Сущность недоступна");
  /**
   * Начинает новый снимок, сохраняя каталог и открытый черновик.
   */
  const handleRefresh = (): void => {
    setPage({ scope, offset: 0, version: undefined });
    setError(request.current ? relationDraftMessages.pendingRemoval : null);
    void query.mutate().catch(() => undefined);
    void selection.mutate().catch(() => undefined);
  };
  /**
   * Открывает соседа отдельным шагом истории браузера.
   */
  const handleSelect = (address: string | null): void => {
    setParams(address === null ? {} : { root: address });
    setError(request.current ? relationDraftMessages.pendingRemoval : null);
    setNotice("");
    screenRef.current?.scrollIntoView({ block: "start" });
  };
  /**
   * Сохраняет режим в URL, чтобы возврат восстанавливал область чтения.
   */
  const handleMode = (value: string): void => {
    const nextParams = new URLSearchParams(params);
    if (value === "chain") {
      nextParams.set("view", "chain");
    } else {
      nextParams.delete("view");
    }
    setParams(nextParams, { replace: true });
  };
  /**
   * Создаёт форму один раз; сворачивание не уничтожает введённые поля.
   */
  const handleCreate = (): void => {
    if (editorData === null && selectedAddress !== null) {
      setEditorData({ root: selectedAddress, version, key: crypto.randomUUID() });
    }
    setEditorOpen(true);
  };
  /**
   * Отзывает явно установленную связь с идемпотентным повтором.
   */
  const handleRemove = async (id: string): Promise<void> => {
    const owner = screenLease.current;
    if (!owner?.isCurrent()) {
      return;
    }
    if (request.current !== null && request.current.edgeId !== id) {
      setError(relationDraftMessages.otherRemoval);
      return;
    }
    request.current ??= { edgeId: id, version, root: selectedAddress ?? "" };
    const original = request.current;
    saveRelationRemoval(projectId, original);
    try {
      await saveRelations(projectId, [{ action: "remove", id }], original.version);
      if (!owner.isCurrent()) {
        return;
      }
      saveRelationRemoval(projectId, null);
      acknowledgeRelations(projectId, [{ action: "remove", id }], original.version);
      request.current = null;
      setNotice("Связь удалена. Сущности сохранены.");
      handleRefresh();
    } catch (failure) {
      if (!owner.isCurrent()) {
        return;
      }
      if (!isRelationWriteUncertain(failure)) {
        request.current = null;
        saveRelationRemoval(projectId, null);
      }
      setError(relationError(failure).message);
    }
  };
  /**
   * Возвращает к окружению после подтверждённой записи.
   */
  const handleSaved = (): void => {
    setEditorOpen(false);
    setEditorData(null);
    setNotice("Связь добавлена.");
    handleRefresh();
  };
  const createLabel = hasEditor ? "Продолжить редактирование" : "Добавить связь";
  const visualizationHref = `${base}/relations/context?${new URLSearchParams({ root: selectedAddress ?? "" })}`;
  const canVisualize = selectedNode !== undefined;
  return (
    <section ref={screenRef} className={styles.root}>
      <div className={styles.header}>
        <div>
          <Title order={1} size="h2">
            Связи проекта
          </Title>
          <Text c="dimmed" size="sm" mt={4}>
            Найдите сущность и проследите, как она связана с остальным проектом.
          </Text>
        </div>
        <Tooltip
          label="Обновить связи и выбранную сущность"
          events={{ hover: true, focus: true, touch: false }}
        >
          <ActionIcon
            variant="default"
            size="lg"
            aria-label="Обновить связи"
            disabled={!hasSelection}
            loading={query.isValidating}
            onClick={handleRefresh}
          >
            <RefreshCw size={16} aria-hidden="true" />
          </ActionIcon>
        </Tooltip>
      </div>
      <div className={styles.workspace}>
        <aside className={styles.catalog} data-hidden={hasSelection}>
          <EntityBrowser projectId={projectId} selected={selectedAddress} onSelect={handleSelect} />
        </aside>
        <div className={styles.content}>
          {hasNoSelection && (
            <div className={styles.welcome}>
              <ThemeIcon variant="light" color="gray" size={64} radius="xl">
                <GitFork size={30} aria-hidden="true" />
              </ThemeIcon>
              <Title order={2} size="h3">
                У каждой связи есть отправная точка
              </Title>
              <Text c="dimmed" size="sm" maw={420}>
                Выберите сущность в каталоге. Здесь будут её зависимости, состав, реализации и
                связанные материалы.
              </Text>
              <div className={styles.steps}>
                <Group gap="sm">
                  <Search size={16} aria-hidden="true" />
                  <Text size="sm">Найдите по названию или ключу</Text>
                </Group>
                <Group gap="sm">
                  <GitFork size={16} aria-hidden="true" />
                  <Text size="sm">Исследуйте связи и переходите к соседям</Text>
                </Group>
                <Group gap="sm">
                  <Plus size={16} aria-hidden="true" />
                  <Text size="sm">Проверьте сохранённые предметные отношения</Text>
                </Group>
              </div>
            </div>
          )}
          {hasSelection && (
            <Stack gap="lg">
              <Button
                variant="subtle"
                color="gray"
                size="compact-sm"
                leftSection={<ArrowLeft size={15} aria-hidden="true" />}
                onClick={() => handleSelect(null)}
                className={styles.back}
              >
                К выбору сущности
              </Button>
              <section className={styles.focus} aria-label="Выбранная сущность">
                <Group wrap="nowrap" align="flex-start">
                  <ThemeIcon color={presentation.color} variant="light" radius="md" size={44}>
                    <presentation.icon size={23} aria-hidden="true" />
                  </ThemeIcon>
                  <div className={styles.focusTitle}>
                    <Group gap="xs">
                      <Text size="xs" c="dimmed">
                        {selectedNode?.key ?? root}
                      </Text>
                      <Badge size="sm" variant="light" color={presentation.color} tt="none">
                        {presentation.label}
                      </Badge>
                    </Group>
                    <Title order={2} size="h3" mt={7}>
                      {selectedTitle}
                    </Title>
                  </div>
                </Group>
                <Group gap="xs" className={styles.create}>
                  {canVisualize && (
                    <Button
                      component={Link}
                      to={visualizationHref}
                      variant="light"
                      leftSection={<GitFork size={16} aria-hidden="true" />}
                    >
                      Смотреть визуализацию связей
                    </Button>
                  )}
                  <Button
                    leftSection={<Plus size={16} aria-hidden="true" />}
                    disabled={!canEdit && !hasEditor}
                    onClick={handleCreate}
                    variant="default"
                  >
                    {createLabel}
                  </Button>
                </Group>
              </section>
              <div className={styles.viewBar}>
                <SegmentedControl
                  aria-label="Область связей"
                  size="sm"
                  value={mode}
                  onChange={handleMode}
                  data={[
                    { value: "direct", label: "Связи сущности" },
                    { value: "chain", label: "Цепочка связей" },
                  ]}
                />
                {isChain && (
                  <NumberInput
                    aria-label="Глубина цепочки"
                    prefix="Шагов: "
                    min={2}
                    max={100}
                    allowDecimal={false}
                    value={depth}
                    w={130}
                    onChange={(value) => {
                      const nextParams = new URLSearchParams(params);
                      nextParams.set("depth", String(value));
                      setParams(nextParams, { replace: true });
                    }}
                  />
                )}
              </div>
              {hasNotice && (
                <Text size="sm" role="status" c="teal">
                  {notice}
                </Text>
              )}
              {hasError && (
                <Alert color="red" title="Не удалось получить актуальные связи" role="alert">
                  {errorMessage}
                  <Button
                    variant="subtle"
                    onClick={() =>
                      request.current ? void handleRemove(request.current.edgeId) : handleRefresh()
                    }
                  >
                    {request.current ? "Проверить исход отзыва" : "Повторить с начала"}
                  </Button>
                </Alert>
              )}
              {isLoading && (
                <Stack aria-label="Загрузка связей">
                  <Skeleton h={100} />
                  <Skeleton h={100} />
                </Stack>
              )}
              {hasBoundary && (
                <Text size="xs" c="dimmed">
                  Показана цепочка до {depth} шагов. Чтобы идти дальше, выберите соседнюю сущность
                  или увеличьте глубину.
                </Text>
              )}
              {hasGraph && (
                <RelationExplorer
                  key={scope}
                  graph={graph}
                  root={selectedAddress}
                  isChain={isChain}
                  offset={currentPage.offset}
                  onSelect={handleSelect}
                  onRemove={handleRemove}
                  onPage={(offset) => setPage({ scope, offset, version })}
                />
              )}
            </Stack>
          )}
        </div>
      </div>
      <Modal.Root
        opened={isEditorOpen}
        onClose={() => setEditorOpen(false)}
        size="lg"
        centered
        keepMounted
      >
        <Modal.Overlay />
        <Modal.Content>
          <Modal.Header role="presentation">
            <Modal.Title>Добавить предметную связь</Modal.Title>
            <Modal.CloseButton aria-label="Свернуть форму связи" />
          </Modal.Header>
          <Modal.Body>
            {hasEditor && (
              <RelationEditor
                key={editorData.key}
                projectId={projectId}
                version={editorData.version}
                root={editorData.root}
                onSaved={handleSaved}
                onCancel={() => setEditorOpen(false)}
              />
            )}
          </Modal.Body>
        </Modal.Content>
      </Modal.Root>
    </section>
  );
};
