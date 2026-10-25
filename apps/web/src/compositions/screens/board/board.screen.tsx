import {
  Alert,
  Button,
  Checkbox,
  Group,
  Loader,
  Modal,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { TASK_COLUMNS } from "@relay/contracts";
import { useState, type ReactElement } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useEntity, useEntityPages, useProject } from "domains/project";
import { TaskCreateForm } from "domains/tasks";
import { BoardColumn } from "./ui/board-column/board-column";
import { boardMessages } from "./config/board.messages";
import styles from "./styles/board.module.css";

/**
 * Показывает задачи выбранной доски в текущих колонках Core.
 *
 * Используется для:
 *  - поиска, чтения продолжаемых колонок и перехода в карточку
 *  - создания задачи с сохраняемым черновиком
 */
export const BoardScreen = (): ReactElement => {
  const { projectId } = useProject();
  const boards = useEntityPages("board");
  const [params, setParams] = useSearchParams();
  const [isCreating, setCreating] = useState(false);
  const navigate = useNavigate();
  const boardItems = boards.items.filter((entity) => entity.kind === "board");
  const selectedId = params.get("board") ?? boardItems[0]?.id;
  const selectedQuery = useEntity(selectedId);
  const selectedEntity = selectedQuery.data?.entity;
  const selected =
    selectedEntity?.kind === "board"
      ? selectedEntity
      : boardItems.find((board) => board.id === selectedId);
  const options = boardItems.map((board) => ({ value: board.id, label: board.data.name }));
  if (selectedId !== undefined && !options.some((option) => option.value === selectedId)) {
    options.unshift({ value: selectedId, label: selected?.data.name ?? selectedId });
  }
  const isEmpty = boards.total === 0;
  const search = params.get("q") ?? "";
  const [query] = useDebouncedValue(search, 250);
  const isBlocked = params.get("readiness") === "blocked";
  const filters = {
    ...(query === "" ? {} : { q: query }),
    ...(isBlocked ? { readiness: "blocked" } : {}),
  };

  /**
   * Сохраняет выбранный фильтр в URL, поддерживая Back/Forward и прямые ссылки.
   */
  function filter(name: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value === "") {
      next.delete(name);
    } else {
      next.set(name, value);
    }
    setParams(next, { replace: name === "q" });
  }

  return (
    <section className={styles.root}>
      <Group justify="space-between" align="flex-start">
        <Stack gap={4}>
          <Title order={1}>{selected?.data.name ?? boardMessages.title}</Title>
          <Text c="dimmed" size="sm">
            {selected?.data.description}
          </Text>
        </Stack>
        <Button onClick={() => setCreating(true)} disabled={selectedId === undefined}>
          {boardMessages.create}
        </Button>
      </Group>
      <Group align="end">
        <Select
          label={boardMessages.board}
          placeholder={boardMessages.choose}
          data={options}
          value={selectedId ?? null}
          allowDeselect={false}
          onChange={(id) => filter("board", id ?? "")}
        />
        <TextInput
          label={boardMessages.search}
          value={search}
          onChange={(event) => filter("q", event.currentTarget.value)}
        />
        <Checkbox
          label={boardMessages.blocked}
          checked={isBlocked}
          onChange={(event) => filter("readiness", event.currentTarget.checked ? "blocked" : "")}
          mb="xs"
        />
        {boards.hasMore && (
          <Button variant="subtle" loading={boards.loading} onClick={boards.loadMore}>
            {boardMessages.moreBoards}
          </Button>
        )}
      </Group>
      {boards.error !== undefined && (
        <Alert color="red" title={boardMessages.boardsError}>
          <Button onClick={boards.reload} variant="subtle">
            {boardMessages.reload}
          </Button>
        </Alert>
      )}
      {boards.loading && <Loader size="sm" aria-label={boardMessages.loading} />}
      {isEmpty && <Text c="dimmed">{boardMessages.noBoards}</Text>}
      {selectedId !== undefined && (
        <div className={styles.columns}>
          {TASK_COLUMNS.map((column) => (
            <BoardColumn
              key={`${selectedId}:${column}`}
              boardId={selectedId}
              column={column}
              filters={filters}
            />
          ))}
        </div>
      )}
      <Modal
        opened={isCreating}
        onClose={() => setCreating(false)}
        title={boardMessages.create}
        size="lg"
      >
        {selectedId !== undefined && (
          <TaskCreateForm
            key={selectedId}
            boardId={selectedId}
            onCreated={(id) => {
              setCreating(false);
              navigate(
                `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(id)}`,
              );
            }}
          />
        )}
      </Modal>
    </section>
  );
};
