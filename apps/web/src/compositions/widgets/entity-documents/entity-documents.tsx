import { useState, type ReactElement } from "react";
import { Alert, Anchor, Button, Group, Modal, Skeleton, Stack, Text, Title } from "@mantine/core";
import { Link } from "react-router-dom";
import { documentRelationCommand, type DocumentSnapshot } from "domains/documents";
import {
  entityHref,
  errorMessage,
  useCommandDraft,
  useDraft,
  useEntityPages,
  useProject,
} from "domains/project";
import { MutationFeedback } from "domains/knowledge";
import type {
  EntityDocumentsProps,
  MaterialsDraft,
  MaterialValues,
  MaterialSelection,
} from "./types/entity-documents-props.type";
import { DocumentSelection } from "./ui/document-selection/document-selection";
import { DocumentLinkForm } from "./ui/document-link-form/document-link-form";
import { DocumentMaterial } from "./ui/document-material/document-material";
import { messages } from "./config/entity-documents.messages";
import styles from "./styles/entity-documents.module.css";

/**
 * Собирает документы задачи, плана или релиза и владеет восстанавливаемой записью связи.
 *
 * Используется для:
 *  - чтения материалов и прикрепления существующего документа
 *  - снятия связи и проверки receipt после закрытия формы или изменения списка по SSE
 */
export const EntityDocuments = ({ target }: EntityDocumentsProps): ReactElement => {
  const { projectId } = useProject();
  const scope = `entity-documents:${target.kind}:${target.id}`;
  const draft = useDraft<MaterialsDraft>(scope, {
    selection: { action: "link", documentId: null, type: "references" },
    editor: null,
  });
  const mutation = useCommandDraft(scope);
  const page = useEntityPages("document", { target: target.id, sort: "updated" });
  const [opened, setOpened] = useState(false);
  const [saved, setSaved] = useState(false);
  const editor = draft.value.editor;
  const documents = page.items.filter((entity) => entity.kind === "document");
  const hasError = page.error !== undefined && page.error !== null;
  const isEmpty = page.total === 0 && !page.loading && !hasError;
  const isEditing = editor !== null;
  const isSelecting = editor === null;
  const canRecover = mutation.uncertain;
  const blocksNewAction = isEditing || mutation.uncertain || mutation.pending;
  const hasDraft = isEditing || draft.value.selection.documentId !== null;
  const attachLabel = hasDraft ? messages.continue : messages.attach;
  const libraryHref = `/projects/${encodeURIComponent(projectId)}/documents?target=${encodeURIComponent(target.id)}&targetKind=${target.kind}`;

  /**
   * Фиксирует прочитанный документ до редактирования; дальнейшее SSE его не заменяет.
   */
  function prepare(source: DocumentSnapshot): void {
    const selection = draft.value.selection;
    const previous = source.entity.data.relations.find(
      (relation) => relation.target.id === target.id && relation.type === selection.type,
    );
    draft.setValue({
      selection,
      editor: {
        source,
        action: selection.action,
        values: { type: selection.type, description: previous?.description ?? "" },
      },
    });
  }

  /**
   * Начинает снятие пары через предварительное versioned read выбранного документа.
   */
  function unlink(documentId: string, type: MaterialSelection["type"]): void {
    if (blocksNewAction) {
      return;
    }
    draft.setValue({ selection: { action: "unlink", documentId, type }, editor: null });
    setSaved(false);
    setOpened(true);
  }

  /**
   * Передаёт намерение домену; общий command draft удерживает exact command/key до исхода.
   */
  async function submit(values: MaterialValues): Promise<void> {
    if (editor === null) {
      return;
    }
    const change =
      editor.action === "link"
        ? { action: "link" as const, target, type: values.type, description: values.description }
        : { action: "unlink" as const, target, type: editor.values.type };
    const result = await mutation.submit(documentRelationCommand(editor.source, change));
    if (result === undefined) {
      return;
    }
    completeRelationWrite();
  }

  /**
   * Завершает черновик только после известного результата записи или её квитанции.
   */
  function completeRelationWrite(): void {
    draft.reset();
    setOpened(false);
    setSaved(true);
    page.reload();
  }

  /**
   * Читает исходную квитанцию без POST и без нового operationKey.
   * Неизвестный исход, включая отсутствие receipt, оставляет черновик заблокированным.
   */
  async function recover(): Promise<void> {
    const result = await mutation.recover();
    if (result !== undefined) {
      completeRelationWrite();
    }
  }

  /**
   * Отбрасывает только известный черновик; unresolved операция остаётся доступной.
   */
  function discard(): void {
    if (mutation.uncertain || mutation.pending) {
      return;
    }
    draft.reset();
    mutation.reset();
    setOpened(false);
  }

  return (
    <section className={styles.root} aria-label={messages.list}>
      <Stack>
        <Group justify="space-between">
          <Title order={2} size="h4">
            {messages.title} · {page.total ?? "—"}
          </Title>
          <Button
            variant="default"
            onClick={() => {
              setSaved(false);
              setOpened(true);
            }}
          >
            {attachLabel}
          </Button>
        </Group>
        <Anchor component={Link} to={libraryHref} size="sm">
          {messages.library}
        </Anchor>
        {saved && (
          <Text role="status" size="sm" c="teal">
            {messages.changed}
          </Text>
        )}
        {hasError && (
          <Alert color="orange">
            {errorMessage(page.error)}
            <Button variant="subtle" onClick={page.reload}>
              {messages.retry}
            </Button>
          </Alert>
        )}
        {page.loading && <Skeleton height={48} />}
        {isEmpty && (
          <Text size="sm" c="dimmed">
            {messages.empty}
          </Text>
        )}
        <ul className={styles.list}>
          {documents.map((document) => (
            <DocumentMaterial
              key={document.id}
              document={document}
              target={target}
              href={entityHref(projectId, document.id)}
              disabled={blocksNewAction}
              onUnlink={unlink}
            />
          ))}
        </ul>
        {page.hasMore && (
          <Button variant="subtle" onClick={page.loadMore} loading={page.loading}>
            {messages.more}
          </Button>
        )}
        <MutationFeedback {...mutation} />
        {canRecover && (
          <Alert color="orange">
            <Text size="sm">{messages.restore}</Text>
            <Button variant="default" loading={mutation.pending} onClick={() => void recover()}>
              {messages.recover}
            </Button>
          </Alert>
        )}
        <Modal opened={opened} onClose={() => setOpened(false)} title={attachLabel} size="lg">
          {isSelecting && (
            <DocumentSelection
              selection={draft.value.selection}
              onSelect={(documentId) =>
                draft.setValue({
                  ...draft.value,
                  selection: { ...draft.value.selection, documentId },
                })
              }
              onPrepare={prepare}
              onDiscard={discard}
            />
          )}
          {editor !== null && (
            <DocumentLinkForm
              key={`${scope}:${editor.source.entity.id}:${editor.action}`}
              target={target}
              editor={editor}
              mutation={mutation}
              onValuesChange={(values) =>
                draft.setValue({ ...draft.value, editor: { ...editor, values } })
              }
              onSubmit={submit}
              onClose={() => setOpened(false)}
              onDiscard={discard}
            />
          )}
        </Modal>
      </Stack>
    </section>
  );
};
