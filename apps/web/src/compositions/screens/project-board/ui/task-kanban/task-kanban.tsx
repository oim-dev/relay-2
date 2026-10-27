import { useCallback, useEffect, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensors,
  useSensor,
} from "@dnd-kit/core";
import type {
  DragStartEvent,
  DragOverEvent,
  DragEndEvent,
  CollisionDetection,
} from "@dnd-kit/core";
import { Alert, Box, Text } from "@mantine/core";
import { arrayMove } from "@dnd-kit/sortable";
import { useReducedMotion } from "@mantine/hooks";
import {
  BoardTaskError,
  KANBAN_COLUMNS,
  TASK_COLUMNS,
  COLUMN_SCHEMA,
  TASK_SUMMARY_SCHEMA,
  moveBoardTask,
  useBoardTaskRefresh,
} from "domains/board-tasks";
import type { TaskSummary, TaskColumn as ColumnId, TasksPage } from "domains/board-tasks";
import { TaskColumn, TaskCardPreview } from "./ui/task-column";
import type { ProductTargetPreview } from "domains/product";
import { getBoardCollisions, getKeyboardCoordinates } from "ui/kanban-dnd";
import type { TaskKanbanProps } from "./types/task-kanban-props.type";
import styles from "./styles/task-kanban.module.css";

/**
 * Координирует перенос задач с видимым местом вставки и сохранением ревизии.
 *
 * Используется для:
 *  - переноса мышью, удержанием на сенсорном экране и клавиатурой
 *  - отображения ошибок записи без потери подтверждённого порядка
 */
export const TaskKanban = (props: TaskKanbanProps) => {
  const { projectId, filters, showCancelled, onOpen, onCreate } = props;
  const boardRef = useRef<HTMLDivElement>(null);
  const detectCollisions: CollisionDetection = (args) => {
    const rect = boardRef.current?.getBoundingClientRect();
    const pointer = args.pointerCoordinates;
    if (
      rect !== undefined &&
      pointer !== null &&
      (pointer.x < rect.left ||
        pointer.x > rect.right ||
        pointer.y < rect.top ||
        pointer.y > rect.bottom)
    )
      return [];
    return getBoardCollisions(args);
  };
  const [active, setActive] = useState<{
    task: TaskSummary;
    version: string;
    width: number;
    height: number;
    /** Название цели, замороженное на время жеста. */
    target: ProductTargetPreview | undefined;
    /** Состояние чтения цели при захвате. */
    targetState: "loading" | "ready" | "error";
  } | null>(null);
  const targetSnapshots = useRef(
    new Map<
      ColumnId,
      {
        targets: Map<string, ProductTargetPreview> | undefined;
        state: "loading" | "ready" | "error";
      }
    >(),
  );
  const snapshots = useRef(new Map<ColumnId, TasksPage>());
  const dragPages = useRef(new Map<ColumnId, TasksPage>());
  const [preview, setPreview] = useState<Map<ColumnId, TaskSummary[]> | null>(null);
  const previewRef = useRef<Map<ColumnId, TaskSummary[]> | null>(null);
  const handleSnapshot = useCallback(
    (
      column: ColumnId,
      page: TasksPage,
      _nextId: string | null,
      targets: Map<string, ProductTargetPreview> | undefined,
      targetState: "loading" | "ready" | "error",
    ): void => {
      snapshots.current.set(column, page);
      targetSnapshots.current.set(column, { targets, state: targetState });
    },
    [],
  );
  const updatePreview = (next: Map<ColumnId, TaskSummary[]> | null): void => {
    previewRef.current = next;
    setPreview(next);
  };
  const [targetId, setTargetId] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);
  const focusTaskId = useRef<string | null>(null);
  useEffect(() => {
    if (active !== null || isSaving || focusTaskId.current === null) return;
    const handle = boardRef.current?.querySelector<HTMLButtonElement>(
      `[data-task-id="${CSS.escape(focusTaskId.current)}"] [data-drag-handle]`,
    );
    (handle ?? boardRef.current)?.focus({ preventScroll: true });
    focusTaskId.current = null;
  }, [active, isSaving]);
  const [error, setError] = useState("");
  const [defect, setDefect] = useState<unknown>();
  const refresh = useBoardTaskRefresh(projectId);
  const shouldReduceMotion = useReducedMotion();
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: (event, args) =>
        getKeyboardCoordinates(
          event,
          args,
          TASK_COLUMNS.map((column) => column.value),
        ),
    }),
  );
  const columns = showCancelled ? TASK_COLUMNS : KANBAN_COLUMNS;
  const columnItems = columns.map((column) => {
    const items = preview?.get(column.value);
    const original = dragPages.current.get(column.value);
    const total =
      items !== undefined && original !== undefined
        ? original.total + items.length - original.items.length
        : undefined;
    return { column, items, total };
  });
  const hasError = error !== "";
  const hasActive = active !== null;
  const activeSize = active === null ? undefined : { width: active.width, height: active.height };
  const dropAnimation = shouldReduceMotion ? null : { duration: 180, easing: "ease-out" };
  const handleStart = (event: DragStartEvent): void => {
    const task = TASK_SUMMARY_SCHEMA.safeParse(event.active.data.current?.task);
    const version = event.active.data.current?.version;
    if (task.success && typeof version === "string") {
      // initial rect ещё может быть null в onDragStart; измеряем оригинал до рендера placeholder.
      const node = boardRef.current?.querySelector<HTMLElement>(
        `[data-task-id="${CSS.escape(task.data.id)}"]`,
      );
      const rect = node?.getBoundingClientRect();
      if (rect === undefined) return;
      const targets = targetSnapshots.current.get(task.data.column);
      dragPages.current = new Map(snapshots.current);
      setActive({
        task: task.data,
        version,
        width: rect.width,
        height: rect.height,
        target: targets?.targets?.get(task.data.productLinks[0]?.id ?? ""),
        targetState: targets?.state ?? "loading",
      });
      updatePreview(
        new Map([...snapshots.current].map(([column, page]) => [column, [...page.items]])),
      );
    }
    setError("");
  };
  const handleOver = (event: DragOverEvent): void => {
    const current = previewRef.current;
    if (current === null || active === null || event.over === null) return;
    const column = COLUMN_SCHEMA.safeParse(event.over.data.current?.column);
    if (!column.success) return;
    const source = [...current].find(([, items]) =>
      items.some((item) => item.id === active.task.id),
    );
    const destination = current.get(column.data);
    if (source === undefined || destination === undefined || source[0] === column.data) return;
    const index = destination.findIndex((item) => item.id === event.over?.id);
    const rect = event.active.rect.current.translated;
    const isAfter = rect !== null && rect.top > event.over.rect.top + event.over.rect.height / 2;
    const insertion = index < 0 ? destination.length : index + Number(isAfter);
    const next = new Map(current);
    next.set(
      source[0],
      source[1].filter((item) => item.id !== active.task.id),
    );
    const target = [...destination];
    target.splice(insertion, 0, { ...active.task, column: column.data });
    next.set(column.data, target);
    updatePreview(next);
    setTargetId(null);
  };
  const handleEnd = async (event: DragEndEvent): Promise<void> => {
    restoreKeyboardFocus(event);
    setActive(null);
    setTargetId(null);
    if (!active || !event.over || isSaving) {
      updatePreview(null);
      return;
    }
    const column = COLUMN_SCHEMA.safeParse(event.over.data.current?.column);
    if (!column.success) {
      updatePreview(null);
      return;
    }
    const current = previewRef.current;
    const items = current?.get(column.data);
    if (current === null || items === undefined) {
      updatePreview(null);
      return;
    }
    const from = items.findIndex((item) => item.id === active.task.id);
    const over = items.findIndex((item) => item.id === event.over?.id);
    if (from < 0) {
      updatePreview(null);
      return;
    }
    const to = over < 0 ? items.length - 1 : over;
    const ordered = arrayMove(items, from, to);
    // В Relay 2 нет серверного ранга: внутри одной колонки жест не создаёт запись.
    if (column.data === active.task.column) {
      updatePreview(null);
      return;
    }
    // Сначала публикуем визуальный результат. Ответ сети не управляет анимацией отпускания.
    updatePreview(new Map(current).set(column.data, ordered));
    setSaving(true);
    try {
      await moveBoardTask(projectId, active.task.id, {
        column: column.data,
        ifRevision: active.task.revision,
        requestId: crypto.randomUUID(),
      });
    } catch (failure) {
      if (failure instanceof BoardTaskError) setError(failure.message);
      else setDefect(failure);
    } finally {
      try {
        // Ошибки чтения принадлежат колонкам; они не должны оставлять жест в состоянии сохранения.
        await refresh(active.task.id).catch(() => undefined);
      } finally {
        updatePreview(null);
        setSaving(false);
      }
    }
  };
  /** Возвращает фокус на ручку после переноса между разными колонками или отмены. */
  const restoreKeyboardFocus = (event: DragEndEvent): void => {
    if (!(event.activatorEvent instanceof KeyboardEvent)) return;
    focusTaskId.current = String(event.active.id);
  };
  if (defect !== undefined) throw defect;
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={detectCollisions}
      onDragStart={handleStart}
      onDragOver={handleOver}
      onDragEnd={handleEnd}
      onDragCancel={(event) => {
        restoreKeyboardFocus(event);
        setActive(null);
        setTargetId(null);
        updatePreview(null);
      }}
      accessibility={{
        screenReaderInstructions: {
          draggable:
            "Пробел — поднять карточку. Стрелки — выбрать место. Пробел — переместить. Escape — отменить.",
        },
        announcements: {
          onDragStart: () => "Карточка поднята",
          onDragOver: ({ over }) => (over ? "Выбрано место вставки" : "За пределами доски"),
          onDragEnd: () => "Перенос отправлен на сохранение",
          onDragCancel: () => "Перенос отменён",
        },
      }}
    >
      {hasError && (
        <Alert color="red" title="Перенос не сохранён" mb="md">
          {error}
        </Alert>
      )}
      {isSaving && (
        <Text role="status" size="sm" className={styles.saving}>
          Сохраняем перемещение…
        </Text>
      )}
      <Box
        ref={boardRef}
        className={styles.root}
        role="region"
        aria-label="Канбан-доска"
        tabIndex={0}
        aria-busy={isSaving}
      >
        {columnItems.map(({ column, items, total }) => (
          <TaskColumn
            key={column.value}
            projectId={projectId}
            filters={filters}
            column={column}
            targetId={targetId}
            isSaving={isSaving}
            preview={items}
            previewTotal={total}
            activeId={active?.task.id ?? null}
            activeSize={activeSize}
            onSnapshot={handleSnapshot}
            onOpen={onOpen}
            onCreate={onCreate}
          />
        ))}
      </Box>
      <DragOverlay dropAnimation={dropAnimation} adjustScale={false}>
        {hasActive && (
          <div className={styles.overlay} style={{ width: active.width, height: active.height }}>
            <TaskCardPreview
              task={active.task}
              target={active.target}
              targetState={active.targetState}
            />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
};
