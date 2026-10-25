import { Alert, Button, Group, Paper, Stack, Text, Title } from "@mantine/core";
import type { ReactElement } from "react";
import type { NamedCommand, TaskCriterion } from "@relay/contracts";
import { useCommandDraft, useDraft } from "domains/project";
import {
  CommandFeedback,
  removeTaskCriterionCommand,
  toggleTaskCriterionCommand,
  taskMessages,
} from "domains/tasks";
import { isEmptyArray } from "shared/value-predicates";
import { CriterionForm } from "../criterion-form/criterion-form";
import { CriterionRow } from "../criterion-row/criterion-row";
import { taskScreenMessages as messages } from "../../config/task-screen.messages";
import type {
  CriterionDraft,
  QuickTaskCommand,
  TaskSectionProps,
} from "../../types/task-editor.types";

/**
 * Показывает и изменяет собственные критерии приёмки задачи.
 *
 * Используется для:
 *  - создания, обновления, снятия и отметки критерия отдельными командами Core
 */
export const TaskCriteria = ({ snapshot }: TaskSectionProps): ReactElement => {
  const name = `task-criteria:${snapshot.task.id}`;
  const editor = useDraft<CriterionDraft | null>(`${name}:editor`, null);
  const quick = useDraft<QuickTaskCommand>(`${name}:quick`, null);
  const action = useCommandDraft(`${name}:quick`);
  const isLocked =
    action.pending || action.uncertain || editor.value !== null || quick.value !== null;
  const hasQuickCommand = quick.value !== null;
  const cannotDiscardQuickCommand = action.pending || action.uncertain;
  const criteriaItems = snapshot.task.data.acceptanceCriteria;
  const isEmpty = isEmptyArray(criteriaItems);
  const isStale =
    editor.value !== null && editor.value.snapshot.task.revision !== snapshot.task.revision;

  /**
   * Фиксирует исходное содержание задачи при открытии критерия.
   */
  function edit(criterion?: TaskCriterion): void {
    const values = {
      title: criterion?.title ?? "",
      summary: criterion?.summary ?? "",
      description: criterion?.description ?? "",
    };
    editor.setValue({ snapshot, criterionId: criterion?.id ?? null, original: values, values });
  }

  /**
   * Запоминает конкретную команду до отправки, сохраняя CAS при неопределённом исходе.
   */
  async function change(command: NamedCommand): Promise<void> {
    quick.setValue(command);
    if ((await action.submit(command)) !== undefined) {
      quick.setValue(null);
    }
  }

  /**
   * Восстанавливает исход прежней отметки или удаления с той же командой и ключом.
   */
  async function retry(): Promise<void> {
    if (quick.value !== null && (await action.submit(quick.value)) !== undefined) {
      quick.setValue(null);
    }
  }

  return (
    <Paper withBorder p="md">
      <Stack>
        <Group justify="space-between">
          <Title order={2} size="h4">
            {messages.criteria}
          </Title>
          <Button size="xs" variant="light" disabled={isLocked} onClick={() => edit()}>
            {messages.criterionAdd}
          </Button>
        </Group>
        {isEmpty && (
          <Text size="sm" c="dimmed">
            {messages.criterionEmpty}
          </Text>
        )}
        {criteriaItems.map((criterion) => (
          <CriterionRow
            key={criterion.id}
            criterion={criterion}
            disabled={isLocked}
            onToggle={() => void change(toggleTaskCriterionCommand(snapshot, criterion))}
            onEdit={() => edit(criterion)}
            onRemove={() => void change(removeTaskCriterionCommand(snapshot, criterion.id))}
          />
        ))}
        <CommandFeedback action={action} />
        {hasQuickCommand && (
          <Group>
            <Button loading={action.pending} onClick={() => void retry()}>
              {taskMessages.retry}
            </Button>
            <Button
              variant="subtle"
              disabled={cannotDiscardQuickCommand}
              onClick={() => {
                quick.setValue(null);
                action.reset();
              }}
            >
              {messages.cancel}
            </Button>
          </Group>
        )}
        {isStale && <Alert color="orange">{taskMessages.snapshotChanged}</Alert>}
        {editor.value !== null && (
          <CriterionForm
            key={editor.value.criterionId ?? "new"}
            name={`${name}:editor-command`}
            draft={editor.value}
            onChange={editor.setValue}
            onClose={() => editor.setValue(null)}
          />
        )}
      </Stack>
    </Paper>
  );
};
