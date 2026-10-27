import clsx from "clsx";
import { useState } from "react";
import { Button, Checkbox, Group, Modal, SegmentedControl, Text, TextInput } from "@mantine/core";
import { Link2, Plus, Search } from "lucide-react";
import { useProductDemo, DocumentationScopes } from "domains/product-demo";
import { isEmptyArray } from "shared/value-predicates";
import type { DocumentScopePickerProps } from "./types/document-scope-picker-props.type";
import styles from "./styles/document-scope-picker.module.css";

/**
 * Демонстрирует множественный выбор областей документа на независимых примерах.
 *
 * Используется для:
 *  - выбора продукта, фич, сценариев и реализаций приложений в макете
 */
export const DocumentScopePicker = (props: DocumentScopePickerProps) => {
  const { defaultValue = [], onChange, className, ...rootAttrs } = props;
  const { scopes } = useProductDemo();
  const [selectedIds, setSelectedIds] = useState(defaultValue);
  const [isOpened, setOpened] = useState(false);
  const [group, setGroup] = useState("product");
  const [query, setQuery] = useState("");
  const search = query.trim().toLocaleLowerCase("ru-RU");
  const optionItems = scopes
    .filter(
      (scope) =>
        scope.group === group &&
        (scope.isActive !== false || selectedIds.includes(scope.id)) &&
        `${scope.name} ${scope.path} ${scope.kind}`.toLocaleLowerCase("ru-RU").includes(search),
    )
    .map((scope) => ({
      ...scope,
      level:
        scope.kind.includes("сценария") || scope.kind === "Сценарий"
          ? 2
          : scope.kind.includes("фичи") || scope.kind === "Фича"
            ? 1
            : 0,
    }));
  const hasNoOptions = isEmptyArray(optionItems);
  const hasNoSelection = isEmptyArray(selectedIds);
  const buttonLabel = hasNoSelection ? "Добавить связи" : "Изменить связи";
  /**
   * Меняет только визуальный выбор поля и сообщает его форме.
   */
  const handleChange = (ids: string[]): void => {
    setSelectedIds(ids);
    onChange?.(ids);
  };
  return (
    <section {...rootAttrs} className={clsx(styles.root, className)} aria-label="Связи документа">
      <div className={styles.heading}>
        <Link2 size={17} aria-hidden="true" />
        <h2 className={styles.title}>Связи</h2>
        <span className={styles.count}>{selectedIds.length}</span>
      </div>
      <Text size="xs" c="dimmed" lh={1.7} mb="md">
        Один документ может относиться к нескольким частям продукта.
      </Text>
      <DocumentationScopes scopeIds={selectedIds} isDetailed />
      <Button
        type="button"
        variant="default"
        size="xs"
        fullWidth
        mt="md"
        leftSection={<Plus size={14} aria-hidden="true" />}
        onClick={() => {
          setQuery("");
          setOpened(true);
        }}
      >
        {buttonLabel}
      </Button>
      <p className={styles.note}>
        Макет: выбираем примеры областей. Реальные связи появятся на следующем этапе.
      </p>
      <Modal
        opened={isOpened}
        onClose={() => setOpened(false)}
        title="Связи документа"
        size="lg"
        centered
        closeButtonProps={{ "aria-label": "Закрыть выбор связей" }}
      >
        <Text size="sm" c="dimmed" lh={1.7} mb="md">
          Выберите несколько областей. Продукт, фича и сценарий выбираются независимо друг от друга.
        </Text>
        <SegmentedControl
          fullWidth
          value={group}
          onChange={setGroup}
          data={[
            { value: "product", label: "Продукт" },
            { value: "application", label: "Приложения" },
          ]}
          mb="md"
          aria-label="Ветка связей"
        />
        <TextInput
          aria-label="Поиск области связи"
          placeholder="Найти область…"
          leftSection={<Search size={15} aria-hidden="true" />}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          mb="md"
        />
        <Checkbox.Group value={selectedIds} onChange={handleChange} label="Области документа">
          <div className={styles.options}>
            {optionItems.map((scope) => (
              <div key={scope.id} className={styles.option} data-level={scope.level}>
                <Checkbox
                  value={scope.id}
                  label={
                    <span className={styles.optionLabel}>
                      <span className={styles.optionName}>{scope.name}</span>
                      <span className={styles.optionPath}>
                        {scope.kind} · {scope.path}
                      </span>
                    </span>
                  }
                />
              </div>
            ))}
            {hasNoOptions && (
              <Text size="sm" c="dimmed" py="xl" ta="center">
                Область не найдена. Попробуйте другой запрос.
              </Text>
            )}
          </div>
        </Checkbox.Group>
        <div className={styles.footer}>
          <Text size="xs" c="dimmed" role="status">
            Выбрано: {selectedIds.length} · связи продукта
          </Text>
          <Group gap="xs">
            <Button
              size="sm"
              variant="subtle"
              color="gray"
              disabled={hasNoSelection}
              onClick={() => handleChange([])}
            >
              Очистить
            </Button>
            <Button size="sm" onClick={() => setOpened(false)}>
              Готово
            </Button>
          </Group>
        </div>
      </Modal>
    </section>
  );
};
