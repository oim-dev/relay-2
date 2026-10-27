import { useCallback, useRef, useState } from "react";
import { Alert, Badge, Button, Group, Menu, Skeleton, ActionIcon, Anchor } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  ArrowLeft,
  Pencil,
  PencilLine,
  MoreHorizontal,
  Pin,
  Archive,
  Copy,
  Check,
  FileText,
} from "lucide-react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useProjectBasePath, useProjectId } from "domains/project";
import {
  useDocument,
  useLibrarySettings,
  saveDocument,
  DOCUMENT_KINDS,
  DOCUMENT_STATUSES,
  DocumentAccessError,
} from "domains/documents";
import type { DocumentInput } from "domains/documents";
import { useDeletionRefresh } from "domains/entities";
import { getProductReturn, ProductPage } from "compositions/widgets/product-page";
import { EntityDelete } from "compositions/widgets/entity-delete";
import { MarkdownView } from "ui/markdown-view";
import { StatePanel } from "ui/state-panel";
import { DocumentContext } from "./ui/document-context";
import type { DocumentAction } from "./types/document-action.type";
import styles from "./styles/product-document.module.css";

/**
 * Показывает назначение, состояние и связи документа до погружения в полный текст.
 *
 * Используется для:
 *  - чтения знаний и черновых проектов решений
 *  - изменения связей и публикации без открытия текстового редактора
 */
export const ProductDocumentScreen = () => {
  const { documentId } = useParams();
  const projectId = useProjectId();
  const base = useProjectBasePath();
  const location = useLocation();
  const navigate = useNavigate();
  const query = useDocument(projectId, documentId ?? null);
  const settings = useLibrarySettings(projectId);
  const refresh = useDeletionRefresh(projectId);
  const requestsRef = useRef(new Map<string, string>());
  const pendingAction = useRef<DocumentAction | undefined>(undefined);
  const [error, setError] = useState("");
  const [isSaving, setSaving] = useState(false);
  const [outline, setOutline] = useState<{ id: string; title: string; level: number }[]>([]);
  const documentData = query.data;
  const backTo = getProductReturn(location.state, `${base}/documents`, base);
  /** Берёт оглавление из настоящих заголовков Markdown, исключая содержимое блоков кода. */
  const articleRef = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    const headings = Array.from(node.querySelectorAll("h1, h2, h3"));
    setOutline(
      headings.map((heading, index) => {
        const id = `document-heading-${index}`;
        heading.id = id;
        heading.setAttribute("tabindex", "-1");
        return { id, title: heading.textContent ?? "", level: Number(heading.tagName.slice(1)) };
      }),
    );
  }, []);
  /** Записывает новую версию документа, не сбрасывая отношения при смене свойств. */
  const handleSave = async (changes: Partial<DocumentInput>): Promise<void> => {
    if (!documentData) return;
    const actionFingerprint = JSON.stringify(changes);
    if (pendingAction.current && pendingAction.current.fingerprint !== actionFingerprint) {
      throw new DocumentAccessError(
        "Предыдущая запись ещё не подтверждена. Повторите исходное действие для проверки квитанции.",
      );
    }
    const input: DocumentInput = {
      name: documentData.name,
      summary: documentData.summary,
      body: documentData.body,
      documentKind: documentData.documentKind,
      documentStatus: documentData.documentStatus,
      sectionId: documentData.sectionId,
      pinned: documentData.pinned,
      relations: documentData.relations,
      ...changes,
    };
    const fingerprint = JSON.stringify([input, documentData.revision]);
    const requestId = requestsRef.current.get(fingerprint) ?? crypto.randomUUID();
    requestsRef.current.set(fingerprint, requestId);
    pendingAction.current ??= {
      fingerprint: actionFingerprint,
      changes: structuredClone(changes),
      input,
      id: documentData.id,
      revision: documentData.revision,
      requestId,
    };
    const action = pendingAction.current;
    try {
      await saveDocument(projectId, action.input, action.requestId, action);
      pendingAction.current = undefined;
      requestsRef.current.delete(fingerprint);
      await refresh().catch(() => undefined);
    } catch (failure) {
      if (!(failure instanceof DocumentAccessError) || !failure.uncertain)
        pendingAction.current = undefined;
      throw failure;
    }
  };
  /** Показывает результат изменения свойств рядом с документом. */
  const handleAction = async (changes: Partial<DocumentInput>): Promise<void> => {
    setSaving(true);
    setError("");
    try {
      await handleSave(changes);
    } catch (failure) {
      if (failure instanceof DocumentAccessError) setError(failure.message);
      else throw failure;
    } finally {
      setSaving(false);
    }
  };
  if (query.isLoading)
    return (
      <ProductPage title="Открываем документ" description="Загружаем содержание и связи">
        <Skeleton height={300} />
      </ProductPage>
    );
  if (!documentData)
    return (
      <StatePanel
        title="Документ недоступен"
        description={query.error?.message ?? "Материал не найден в этом проекте."}
        action={
          <Button variant="default" onClick={() => void query.mutate()}>
            Повторить чтение
          </Button>
        }
      />
    );
  const isDraft = documentData.documentStatus === "draft";
  const isArchived = documentData.documentStatus === "archived";
  const isProposal = documentData.documentKind === "proposal";
  const statusColor = isDraft ? "yellow" : "gray";
  const statusInk = isDraft ? "var(--tasks-warning-ink)" : "var(--tasks-muted)";
  const updatedLabel = documentData.updatedAt
    ? new Date(documentData.updatedAt).toLocaleDateString("ru-RU", {
        day: "numeric",
        month: "long",
      })
    : "";
  const draftDescription = isProposal
    ? "Проектируется, ещё не принято. Документ сохраняет варианты, вопросы и будущую реализацию."
    : "Материал ещё готовится. Его содержание не считается принятым решением.";
  const sectionName =
    settings.data?.sections.find((section) => section.id === documentData.sectionId)?.name ??
    "Без раздела";
  const hasError = error !== "" || query.error !== undefined;
  const errorMessage = error || query.error?.message;
  const pinLabel = documentData.pinned ? "Открепить" : "Закрепить в библиотеке";
  const publishLabel = isProposal ? "Принять решение" : "Сделать действующим";
  const publishKind = isProposal ? "decision" : documentData.documentKind;
  return (
    <ProductPage
      className={styles.page}
      title={documentData.name}
      description={documentData.summary}
      meta={
        <Group gap="xs" mt="sm">
          <span className={styles.type}>
            <FileText size={14} aria-hidden="true" />
            {DOCUMENT_KINDS[documentData.documentKind]}
          </span>
          <Badge color={statusColor} c={statusInk} variant="light" tt="none" size="sm">
            {DOCUMENT_STATUSES[documentData.documentStatus]}
          </Badge>
          <span className={styles.key}>{documentData.key}</span>
          <span className={styles.type}>Обновлён {updatedLabel}</span>
          {documentData.pinned && <Pin size={13} aria-label="Закреплён" />}
        </Group>
      }
      actions={
        <Group gap="xs">
          <Button
            component={Link}
            to={`${base}/documents/${documentData.id}/edit`}
            state={{ returnTo: backTo }}
            variant="default"
            leftSection={<Pencil size={15} />}
          >
            Редактировать
          </Button>
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ActionIcon
                variant="default"
                size="lg"
                aria-label="Действия с документом"
                loading={isSaving}
              >
                <MoreHorizontal size={18} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                leftSection={<Copy size={14} />}
                onClick={() => {
                  void navigator.clipboard
                    .writeText(window.location.href)
                    .then(() => notifications.show({ message: "Ссылка скопирована" }))
                    .catch(() => setError("Не удалось скопировать ссылку"));
                }}
              >
                Скопировать ссылку
              </Menu.Item>
              <Menu.Item
                leftSection={<Pin size={14} />}
                onClick={() => void handleAction({ pinned: !documentData.pinned })}
              >
                {pinLabel}
              </Menu.Item>
              {isDraft && (
                <Menu.Item
                  leftSection={<Check size={14} />}
                  onClick={() =>
                    void handleAction({ documentStatus: "active", documentKind: publishKind })
                  }
                >
                  {publishLabel}
                </Menu.Item>
              )}
              {!isDraft && (
                <Menu.Item
                  leftSection={<PencilLine size={14} />}
                  onClick={() => void handleAction({ documentStatus: "draft" })}
                >
                  Вернуть в черновики
                </Menu.Item>
              )}
              {!isArchived && (
                <Menu.Item
                  leftSection={<Archive size={14} />}
                  onClick={() => void handleAction({ documentStatus: "archived" })}
                >
                  В архив
                </Menu.Item>
              )}
            </Menu.Dropdown>
          </Menu>
          <EntityDelete
            kind="document"
            entityId={documentData.id}
            onDeleted={() => navigate(`${base}/documents`, { replace: true })}
          />
        </Group>
      }
    >
      <Anchor component={Link} to={backTo} className={styles.back} c="dimmed">
        <ArrowLeft size={14} aria-hidden="true" />
        Назад
      </Anchor>
      {hasError && (
        <Alert color="orange" mb="md">
          {errorMessage}
          <Button
            size="xs"
            variant="subtle"
            onClick={() => {
              if (pendingAction.current) void handleAction(pendingAction.current.changes);
              else void query.mutate();
            }}
          >
            {pendingAction.current ? "Проверить сохранение" : "Обновить"}
          </Button>
        </Alert>
      )}
      {isDraft && (
        <div className={styles.draftNotice}>
          <PencilLine size={18} aria-hidden="true" />
          <div>
            <strong>Черновик</strong>
            <p>{draftDescription}</p>
          </div>
        </div>
      )}
      {isArchived && (
        <Alert color="gray" title="Архивный документ" mb="lg">
          Сохранён для восстановления контекста. Не используйте как действующую инструкцию.
        </Alert>
      )}
      <div className={styles.root}>
        <article
          key={documentData.body}
          ref={articleRef}
          className={styles.document}
          aria-label="Содержание документа"
        >
          <MarkdownView text={documentData.body} />
        </article>
        <DocumentContext
          document={documentData}
          sectionName={sectionName}
          outline={outline}
          onSave={handleSave}
        />
      </div>
    </ProductPage>
  );
};
