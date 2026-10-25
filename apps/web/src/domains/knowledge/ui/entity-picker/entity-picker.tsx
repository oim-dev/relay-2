import { useState, type ReactElement } from "react";
import { Alert, Button, Select, Stack } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { entityName, errorMessage, useEntity, useEntityPages } from "domains/project";
import type { EntityPickerProps } from "./types/entity-picker-props.type";
import { knowledgeMessages as messages } from "../../config/knowledge.messages";

/**
 * Выбирает устойчивую ссылку из серверного каталога с поиском и продолжением.
 *
 * Используется для:
 *  - создания связей без ручного ввода неоднозначного ключа
 */
export const EntityPicker = (props: EntityPickerProps): ReactElement => {
  const [search, setSearch] = useState("");
  const [query] = useDebouncedValue(search, 200);
  const pages = useEntityPages(props.kind, {
    ...props.filters,
    ...(query === "" ? {} : { q: query }),
  });
  const selected = useEntity(props.value ?? undefined);
  const options = pages.items.map((entity) => ({
    value: entity.id,
    label: `${entity.key} · ${entityName(entity)}`,
  }));
  if (props.value !== null && !options.some((entry) => entry.value === props.value)) {
    const entity = selected.data?.entity;
    options.unshift({
      value: props.value,
      label: entity === undefined ? props.value : `${entity.key} · ${entityName(entity)}`,
    });
  }
  const failure = pages.error ?? selected.error;
  const hasError = failure !== undefined && failure !== null;
  // Mantine выставляет data-path, но не включает его в GetInputPropsReturnType.
  const fieldPath =
    props.field !== undefined && "data-path" in props.field ? props.field["data-path"] : undefined;
  const inputPath = typeof fieldPath === "string" ? fieldPath : undefined;
  return (
    <Stack gap={4}>
      <Select
        label={props.label}
        placeholder={messages.pickerSearch}
        data={options}
        value={props.value}
        onChange={props.onChange}
        searchable
        clearable
        searchValue={search}
        onSearchChange={setSearch}
        disabled={props.disabled ?? false}
        error={props.field?.error}
        nothingFoundMessage={messages.empty}
        data-path={inputPath}
        {...(props.field?.onBlur === undefined ? {} : { onBlur: props.field.onBlur })}
      />
      {pages.hasMore && (
        <Button
          size="compact-xs"
          variant="subtle"
          onClick={pages.loadMore}
          loading={pages.loading}
          disabled={props.disabled ?? false}
        >
          {messages.pickerMore}
        </Button>
      )}
      {hasError && (
        <Alert color="orange">
          {errorMessage(failure)}
          <Button variant="subtle" size="compact-xs" onClick={pages.reload}>
            {messages.pickerRetry}
          </Button>
        </Alert>
      )}
    </Stack>
  );
};
