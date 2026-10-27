import { useEffect, useRef, useState } from "react";
import { Alert, Button, Checkbox, Group, Select, Stack, Text, TextInput } from "@mantine/core";
import { ArrowDown, ArrowDownUp } from "lucide-react";
import { useForm } from "@mantine/form";
import {
  getRelations,
  relationError,
  saveRelations,
  isRelationWriteUncertain,
  acknowledgeRelations,
} from "domains/relations";
import { MarkdownField } from "ui/markdown-field";
import { getRelationLabel } from "../../config/relation-presentation";
import { relationDraftMessages } from "../../config/relation-draft.messages";
import { EntityPicker } from "compositions/widgets/entity-picker";
import type { RelationEditorProps, RelationFormValues } from "./types/relation-editor-props.type";
import styles from "./styles/relation-editor.module.css";
import {
  relationDraftKey,
  readRelationDraft,
  claimRelationDraft,
  saveRelationDraft,
  clearRelationDraft,
} from "../../helpers/relation-draft";
import type { RelationDraftLease } from "../../types/relation-draft.types";
import type { RelationOperation } from "domains/relations";

/**
 * Передаёт поддерживаемую предметную связь с исходной версией и защитой повторного запроса.
 *
 * Используется для:
 *  - отношений документа и зависимостей/необязательных связей задач через текущие команды Core
 */
export const RelationEditor = (props: RelationEditorProps) => {
  const { projectId, root, onSaved, onCancel } = props;
  const storageKey = relationDraftKey(projectId, root);
  const [initial] = useState(() => readRelationDraft(storageKey, root, props.version));
  const snapshot = useRef(initial);
  const lease = useRef<RelationDraftLease | null>(null);
  const [version, setVersion] = useState(initial.version);
  const [error, setError] = useState<string | null>(initial.error);
  const [isUncertain, setUncertain] = useState(initial.uncertain);
  const [isCustomType, setCustomType] = useState(false);
  useEffect(() => {
    const owner = claimRelationDraft(storageKey);
    lease.current = owner;
    saveRelationDraft(storageKey, owner, snapshot.current);
    return () => {
      owner.dispose();
      if (lease.current === owner) {
        lease.current = null;
      }
    };
  }, [storageKey]);
  const form = useForm<RelationFormValues>({
    mode: "uncontrolled",
    validateInputOnBlur: true,
    initialValues: initial.values,
    onValuesChange: (values) => {
      const owner = lease.current;
      if (!owner?.isCurrent()) {
        return;
      }
      snapshot.current = { ...snapshot.current, values: structuredClone(values) };
      saveRelationDraft(storageKey, owner, snapshot.current);
    },
    validate: {
      from: (value) => (value ? null : "Выберите начало связи"),
      to: (value) => (value ? null : "Выберите конец связи"),
      type: (value) =>
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
          ? null
          : "Используйте латинские буквы, цифры, точку, дефис или подчёркивание",
    },
  });
  const hasError = error !== null;
  const typeItems = ["documents", "references", "depends-on", "related"].map((value) => ({
    value,
    label: getRelationLabel(value),
  }));
  /**
   * Меняет направление целиком, сохраняя обе выбранные сущности.
   */
  const handleSwap = (): void => {
    const { from, to } = form.getValues();
    form.setValues({ from: to, to: from });
  };
  /** Передаёт фокус первому незаполненному полю. */
  const handleValidationError = (errors: typeof form.errors): void => {
    const first = Object.keys(errors)[0];
    if (first !== undefined) {
      form.getInputNode(first)?.focus();
    }
  };
  /** Отправляет изменения по действию пользователя, сохраняя черновик при ошибке. */
  const handleSubmit = async (values: RelationFormValues): Promise<void> => {
    const owner = lease.current;
    if (!owner?.isCurrent()) {
      return;
    }
    setError(null);
    const operations: RelationOperation[] = [
      {
        action: "add",
        from: values.from,
        to: values.to,
        type: values.type,
        description: values.description,
      },
    ];
    snapshot.current = {
      version,
      values: structuredClone(values),
      uncertain: true,
      error: relationDraftMessages.pendingWrite,
    };
    saveRelationDraft(storageKey, owner, snapshot.current);
    setUncertain(true);
    try {
      await saveRelations(projectId, operations, version);
      if (!owner.isCurrent()) {
        return;
      }
      clearRelationDraft(storageKey, owner);
      acknowledgeRelations(projectId, operations, version);
      onSaved();
    } catch (failure) {
      if (!owner.isCurrent()) {
        return;
      }
      const uncertain = isRelationWriteUncertain(failure);
      const message = relationError(failure).message;
      snapshot.current = { ...snapshot.current, uncertain, error: message };
      saveRelationDraft(storageKey, owner, snapshot.current);
      setUncertain(uncertain);
      setError(message);
    }
  };
  /** Перечитывает версию только по явному действию, не заменяя введённые поля. */
  const handleRefresh = async (): Promise<void> => {
    const owner = lease.current;
    if (!owner?.isCurrent() || snapshot.current.uncertain) {
      return;
    }
    try {
      const fresh = (await getRelations(projectId, { limit: 1 })).version;
      if (!owner.isCurrent()) {
        return;
      }
      snapshot.current = { ...snapshot.current, version: fresh, error: null };
      saveRelationDraft(storageKey, owner, snapshot.current);
      setVersion(fresh);
      setError(null);
    } catch (failure) {
      if (!owner.isCurrent()) {
        return;
      }
      setError(relationError(failure).message);
    }
  };
  return (
    <form onSubmit={form.onSubmit(handleSubmit, handleValidationError)} noValidate>
      <fieldset className={styles.root} disabled={form.submitting}>
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            Документ может описывать сущность или ссылаться на неё. Между задачами доступны
            зависимость и необязательная связь. Остальной состав меняется у его владельца.
          </Text>
          <EntityPicker
            key={form.key("from")}
            projectId={projectId}
            label="От какой сущности"
            placeholder="Найдите по названию или ключу"
            required
            disabled={isUncertain}
            {...form.getInputProps("from")}
          />
          <Group justify="space-between">
            <ArrowDown size={18} aria-hidden="true" />
            <Button
              variant="subtle"
              color="gray"
              size="compact-xs"
              leftSection={<ArrowDownUp size={14} aria-hidden="true" />}
              onClick={handleSwap}
              disabled={isUncertain}
            >
              Поменять направление
            </Button>
          </Group>
          {!isCustomType && (
            <Select
              key={form.key("type")}
              label="Как связана"
              required
              allowDeselect={false}
              disabled={isUncertain}
              data={typeItems}
              {...form.getInputProps("type")}
            />
          )}
          {isCustomType && (
            <TextInput
              key={form.key("type")}
              label="Свой тип отношения"
              description="Латинские буквы, цифры, точка, дефис или подчёркивание"
              required
              disabled={isUncertain}
              {...form.getInputProps("type")}
            />
          )}
          <Checkbox
            label="Произвольные типы не поддерживаются Core"
            disabled
            size="xs"
            checked={isCustomType}
            onChange={(event) => {
              setCustomType(event.currentTarget.checked);
              form.setFieldValue("type", "references");
            }}
          />
          <EntityPicker
            key={form.key("to")}
            projectId={projectId}
            label="С какой сущностью"
            placeholder="Выберите связанную сущность"
            required
            disabled={isUncertain}
            {...form.getInputProps("to")}
          />
          <MarkdownField
            key={form.key("description")}
            label="Зачем нужна связь"
            placeholder="Необязательно: поясните смысл связи. Поддерживается Markdown."
            disabled={form.submitting || isUncertain}
            minRows={3}
            {...form.getInputProps("description")}
          />
          <Text size="xs" c="dimmed">
            Пояснение сохраняется только у документа. Для зависимости и связи задач оставьте его
            пустым; допустимость операции проверит Core.
          </Text>
          {hasError && (
            <Alert color="red" title="Связь не подтверждена" role="alert">
              {error}
              <Button variant="subtle" disabled={isUncertain} onClick={() => void handleRefresh()}>
                Обновить версию, сохранив ввод
              </Button>
            </Alert>
          )}
          <Group>
            <Button type="submit" loading={form.submitting}>
              {isUncertain ? "Проверить исход сохранения" : "Сохранить связь"}
            </Button>
            <Button variant="default" onClick={onCancel}>
              Свернуть, сохранив ввод
            </Button>
          </Group>
        </Stack>
      </fieldset>
    </form>
  );
};
