import { Alert, Button, Select, Stack } from "@mantine/core";
import { useState, type ReactElement } from "react";
import { entityName, useEntityPages } from "domains/project";
import { taskMessages } from "../../config/tasks.messages";
import type { ReferencePickerProps } from "./types/reference-picker-props.type";

/**
 * Выбирает устойчивый ID из страниц текущих записей.
 *
 * Используется для:
 *  - назначения родителя, зависимости и продуктовой цели
 */
export const ReferencePicker = (props: ReferencePickerProps): ReactElement => {
  const { kind, defaultValue = "", onChange, ...field } = props;
  const query = useEntityPages(kind);
  const [selected, setSelected] = useState(defaultValue);
  const options = query.items.map((entity) => ({
    value: entity.id,
    label: `${entity.key} · ${entityName(entity)}`,
  }));
  if (selected !== "" && !options.some((option) => option.value === selected)) {
    options.unshift({ value: selected, label: selected });
  }
  return (
    <Stack gap="xs">
      <Select
        {...field}
        searchable
        clearable
        data={options}
        value={selected || null}
        placeholder={taskMessages.choose}
        onChange={(id) => {
          setSelected(id ?? "");
          onChange?.(id ?? "");
        }}
      />
      {query.error !== undefined && (
        <Alert color="red" title={taskMessages.loadError}>
          <Button variant="subtle" onClick={query.reload}>
            {taskMessages.reload}
          </Button>
        </Alert>
      )}
      {query.hasMore && (
        <Button variant="subtle" size="compact-xs" loading={query.loading} onClick={query.loadMore}>
          {taskMessages.more}
        </Button>
      )}
    </Stack>
  );
};
