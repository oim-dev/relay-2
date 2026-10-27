import { useRef, useState } from "react";
import { useForm } from "@mantine/form";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  ScrollArea,
  Text,
  TextInput,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { Link, useLocation } from "react-router-dom";
import { BookOpen, Link2, Plus, Search } from "lucide-react";
import { useProjectId, useProjectBasePath } from "domains/project";
import { useEntities, useDeletionRefresh } from "domains/entities";
import {
  attachDocuments,
  DOCUMENT_KINDS,
  DOCUMENT_STATUSES,
  DocumentAccessError,
} from "domains/documents";
import { isEmptyArray } from "shared/value-predicates";
import type { EntityDocumentsProps } from "./types/entity-documents-props.type";
import styles from "./styles/entity-documents.module.css";

/**
 * Показывает общие документы непосредственно в месте работы с сущностью.
 *
 * Используется для:
 *  - прикрепления существующих материалов и создания нового документа в контексте
 */
export const EntityDocuments = ({ target, onOpenedChange }: EntityDocumentsProps) => {
  const projectId = useProjectId();
  const base = useProjectBasePath();
  const location = useLocation();
  const refresh = useDeletionRefresh(projectId);
  const [page, setPage] = useState<{ offset: number; version?: string }>({ offset: 0 });
  const reference = `${target.kind}:${target.id}`;
  const response = useEntities(projectId, {
    kind: "document",
    target: reference,
    limit: 5,
    sort: "updated",
    ...page,
  });
  const [isOpened, setOpened] = useState(false);
  const [query, setQuery] = useState("");
  const [search] = useDebouncedValue(query, 200);
  const [searchPage, setSearchPage] = useState<{ offset: number; version?: string }>({ offset: 0 });
  const available = useEntities(projectId, {
    kind: "document",
    q: search,
    limit: 40,
    archived: "false",
    ...searchPage,
  });
  const [error, setError] = useState("");
  const [defect, setDefect] = useState<Error>();
  const requests = useRef(new Map<string, string>());
  const selectedRevisions = useRef(new Map<string, number>());
  const form = useForm<{ selected: string[] }>({
    mode: "uncontrolled",
    initialValues: { selected: [] },
  });
  const selectedIds = form.useWatchValue("selected");
  const returnTo = `${location.pathname}${location.search}`;
  const documentItems = (response.data?.items ?? []).map((entry) => ({
    ...entry,
    href: `${base}/documents/${entry.ref.id}`,
    kindLabel: entry.document ? DOCUMENT_KINDS[entry.document.kind] : "Документ",
    statusLabel: entry.document ? DOCUMENT_STATUSES[entry.document.status] : "",
    isDraft: entry.document?.status === "draft",
    statusColor: entry.document?.status === "draft" ? "yellow" : "gray",
    statusInk:
      entry.document?.status === "draft" ? "var(--tasks-warning-ink)" : "var(--tasks-muted)",
    hasSummary: entry.summary !== "",
  }));
  const optionItems = (available.data?.items ?? []).map((entry) => ({
    ...entry,
    isSelected: selectedIds.includes(entry.ref.id),
    kindLabel: entry.document ? DOCUMENT_KINDS[entry.document.kind] : "Документ",
    isDraft: entry.document?.status === "draft",
  }));
  const hasNoDocuments = isEmptyArray(documentItems) && !response.isLoading && !response.error;
  const hasMore = response.data?.nextOffset !== null && response.data?.nextOffset !== undefined;
  const hasPrevious = page.offset > 0;
  const hasSearchMore =
    available.data?.nextOffset !== null && available.data?.nextOffset !== undefined;
  const hasError = error !== "";
  const hasSelection = !isEmptyArray(selectedIds);
  /** Передаёт фокус вложенному окну и возвращает его родителю. */
  const handleOpened = (opened: boolean): void => {
    setOpened(opened);
    onOpenedChange?.(opened);
  };
  /** Прикрепляет выбранные документы без копирования и сохраняет неприменённый выбор при отказе. */
  const handleAttach = async ({ selected }: { selected: string[] }): Promise<void> => {
    setError("");
    try {
      const documents = selected.map((id) => {
        const revision = selectedRevisions.current.get(id);
        if (revision === undefined)
          throw new Error("Не сохранена исходная ревизия выбранного документа.");
        return { id, revision };
      });
      const fingerprint = JSON.stringify([documents, target]);
      const requestId = requests.current.get(fingerprint) ?? crypto.randomUUID();
      requests.current.set(fingerprint, requestId);
      await attachDocuments(projectId, documents, target, requestId);
      await refresh();
      form.setFieldValue("selected", []);
      selectedRevisions.current.clear();
      handleOpened(false);
    } catch (failure) {
      await refresh();
      if (failure instanceof DocumentAccessError) setError(failure.message);
      else
        setDefect(
          failure instanceof Error ? failure : new Error("Не удалось прикрепить документы"),
        );
    }
  };
  if (defect) throw defect;
  return (
    <section className={styles.root} aria-label="Документы сущности">
      <header className={styles.heading}>
        <h2 className={styles.title}>
          <BookOpen size={17} aria-hidden="true" />
          Документы <span>{response.data?.total ?? 0}</span>
        </h2>
        <Group gap={4}>
          <Button
            variant="subtle"
            color="gray"
            size="compact-xs"
            leftSection={<Link2 size={13} />}
            onClick={() => {
              handleOpened(true);
              setError("");
            }}
          >
            Прикрепить
          </Button>
          <Button
            component={Link}
            to={`${base}/documents/new?target=${encodeURIComponent(reference)}`}
            state={{ returnTo }}
            variant="subtle"
            color="gray"
            size="compact-xs"
            leftSection={<Plus size={13} />}
          >
            Создать
          </Button>
        </Group>
      </header>
      {response.error && (
        <Alert color="orange">
          {response.error.message}
          <Button
            size="xs"
            variant="subtle"
            onClick={() => {
              setPage({ offset: 0 });
              void response.mutate();
            }}
          >
            Повторить
          </Button>
        </Alert>
      )}
      {hasNoDocuments && (
        <Text size="sm" c="dimmed">
          Прикрепите правила, инструкцию или черновик решения — контекст останется рядом с работой.
        </Text>
      )}
      <ul className={styles.list}>
        {documentItems.map((entry) => (
          <li key={entry.ref.id} className={styles.item}>
            <Anchor
              component={Link}
              to={entry.href}
              state={{ returnTo }}
              c="inherit"
              fw={550}
              size="sm"
            >
              {entry.title}
            </Anchor>
            <Group gap={6} mt={4}>
              <Text size="xs" c="dimmed">
                {entry.kindLabel}
              </Text>
              <Badge
                variant="light"
                color={entry.statusColor}
                c={entry.statusInk}
                size="xs"
                tt="none"
              >
                {entry.statusLabel}
              </Badge>
            </Group>
            {entry.hasSummary && (
              <Text size="xs" c="dimmed" mt={6}>
                {entry.summary}
              </Text>
            )}
          </li>
        ))}
      </ul>
      <Group justify="space-between" mt="sm">
        <Button
          size="compact-xs"
          variant="subtle"
          color="gray"
          disabled={!hasPrevious}
          onClick={() =>
            setPage({ offset: Math.max(0, page.offset - 5), version: response.data?.version })
          }
        >
          Назад
        </Button>
        <Button
          size="compact-xs"
          variant="subtle"
          color="gray"
          disabled={!hasMore}
          onClick={() =>
            setPage({ offset: response.data?.nextOffset ?? 0, version: response.data?.version })
          }
        >
          Ещё документы
        </Button>
      </Group>
      <Modal.Root opened={isOpened} onClose={() => handleOpened(false)} size="lg" centered>
        <Modal.Overlay />
        <Modal.Content>
          <Modal.Header role="presentation">
            <Modal.Title>Прикрепить документы</Modal.Title>
            <Modal.CloseButton aria-label="Закрыть выбор документов" />
          </Modal.Header>
          <Modal.Body>
            <form
              onSubmit={(event) => {
                event.stopPropagation();
                form.onSubmit(handleAttach)(event);
              }}
            >
              <TextInput
                placeholder="Найти документ…"
                aria-label="Поиск документов для прикрепления"
                leftSection={<Search size={15} />}
                value={query}
                onChange={(event) => {
                  setQuery(event.currentTarget.value);
                  setSearchPage({ offset: 0 });
                }}
              />
              <ScrollArea.Autosize mah={360} mt="md">
                <fieldset className={styles.fields} disabled={form.submitting}>
                  {optionItems.map((entry) => (
                    <Checkbox
                      key={entry.ref.id}
                      mb="md"
                      checked={entry.isSelected}
                      onChange={(event) => {
                        if (event.currentTarget.checked)
                          selectedRevisions.current.set(entry.ref.id, entry.revision);
                        else selectedRevisions.current.delete(entry.ref.id);
                        form.setFieldValue(
                          "selected",
                          event.currentTarget.checked
                            ? [...selectedIds, entry.ref.id]
                            : selectedIds.filter((id) => id !== entry.ref.id),
                        );
                      }}
                      label={
                        <span>
                          <Text component="span" size="sm" fw={500}>
                            {entry.title}
                          </Text>
                          <Text size="xs" c="dimmed">
                            {entry.kindLabel}
                          </Text>
                          {entry.isDraft && (
                            <Badge
                              variant="light"
                              color="yellow"
                              c="var(--tasks-warning-ink)"
                              size="xs"
                              tt="none"
                            >
                              Черновик
                            </Badge>
                          )}
                        </span>
                      }
                    />
                  ))}
                </fieldset>
              </ScrollArea.Autosize>
              {available.error && (
                <Alert color="orange">
                  {available.error.message}
                  <Button
                    variant="subtle"
                    size="xs"
                    onClick={() => {
                      setSearchPage({ offset: 0 });
                      void available.mutate();
                    }}
                  >
                    Повторить
                  </Button>
                </Alert>
              )}
              <Group justify="space-between">
                <Button
                  size="compact-xs"
                  variant="subtle"
                  disabled={searchPage.offset === 0}
                  onClick={() =>
                    setSearchPage({
                      offset: Math.max(0, searchPage.offset - 40),
                      version: available.data?.version,
                    })
                  }
                >
                  Назад
                </Button>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  disabled={!hasSearchMore}
                  onClick={() =>
                    setSearchPage({
                      offset: available.data?.nextOffset ?? 0,
                      version: available.data?.version,
                    })
                  }
                >
                  Ещё варианты
                </Button>
              </Group>
              {hasError && (
                <Alert color="red" mt="md">
                  {error}
                </Alert>
              )}
              <Group justify="space-between" mt="lg">
                <Text size="xs" c="dimmed">
                  Выбрано {selectedIds.length}
                </Text>
                <Button type="submit" loading={form.submitting} disabled={!hasSelection}>
                  Прикрепить
                </Button>
              </Group>
            </form>
          </Modal.Body>
        </Modal.Content>
      </Modal.Root>
    </section>
  );
};
