import { ScrollArea, Stack, Text } from "@mantine/core";
import { entityKindLabel } from "domains/entities";
import type { DeletionListProps } from "./types/deletion-list-props.type";

/**
 * Показывает полный список последствий удаления с ограниченной высотой.
 *
 * Используется для:
 *  - перечисления удаляемых и сохраняемых записей в диалоге
 */
export const DeletionList = (props: DeletionListProps) => {
  const { title, entries, maxHeight } = props;
  const entryItems = entries.map((entry) => ({
    id: `${entry.ref.kind}:${entry.ref.id}`,
    label: `${entityKindLabel(entry.ref.kind)} · ${entry.key} — ${entry.title}`,
  }));
  return (
    <Stack gap="sm">
      <Text fw={600}>
        {title}: {entries.length}
      </Text>
      <ScrollArea.Autosize mah={maxHeight} type="auto">
        <Stack gap="xs">
          {entryItems.map((entry) => (
            <Text size="sm" key={entry.id} style={{ overflowWrap: "anywhere" }}>
              {entry.label}
            </Text>
          ))}
        </Stack>
      </ScrollArea.Autosize>
    </Stack>
  );
};
