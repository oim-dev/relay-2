import type { ReactElement } from "react";
import { Button, Card, Group, Select, Stack, TextInput, Title } from "@mantine/core";
import { DOCUMENT_TARGET_KINDS } from "@relay/contracts";
import { EntityPicker } from "domains/knowledge";
import { relationOptions } from "domains/documents";
import type { DocumentRelationsProps } from "./types/document-relations-props.type";
import { messages, targetKindLabels } from "../../config/documents.messages";

const targetOptions = DOCUMENT_TARGET_KINDS.map((value) => ({
  value,
  label: targetKindLabels[value],
}));

/**
 * Редактирует структурированные связи документа через реальные каталоги целей.
 *
 * Используется для:
 *  - добавления, пояснения и снятия отношений в одной атомарной записи документа
 */
export const DocumentRelations = ({ form, disabled }: DocumentRelationsProps): ReactElement => {
  const relations = form.useWatchValue("relations");
  return (
    <Stack>
      <Title order={3} size="h5">
        {messages.relations}
      </Title>
      {relations.map((relation, index) => (
        <Card key={relation.rowId} withBorder>
          <Stack gap="xs">
            <Group grow>
              <Select
                label={messages.targetKind}
                data={targetOptions}
                value={relation.targetKind}
                allowDeselect={false}
                disabled={disabled}
                onChange={(value) => {
                  const kind = DOCUMENT_TARGET_KINDS.find((item) => item === value);
                  if (kind !== undefined) {
                    form.setFieldValue(`relations.${index}.targetKind`, kind);
                    form.setFieldValue(`relations.${index}.target`, null);
                  }
                }}
              />
              <Select
                label={messages.relationType}
                data={relationOptions}
                allowDeselect={false}
                key={form.key(`relations.${index}.type`)}
                {...form.getInputProps(`relations.${index}.type`)}
                disabled={disabled}
              />
            </Group>
            <EntityPicker
              kind={relation.targetKind}
              label={messages.relationTarget}
              value={relation.target}
              onChange={(id) => form.setFieldValue(`relations.${index}.target`, id)}
              field={form.getInputProps(`relations.${index}.target`)}
              disabled={disabled}
            />
            <TextInput
              label={messages.relationDescription}
              key={form.key(`relations.${index}.description`)}
              {...form.getInputProps(`relations.${index}.description`)}
              disabled={disabled}
            />
            <Button
              variant="subtle"
              color="red"
              size="xs"
              onClick={() => form.removeListItem("relations", index)}
              disabled={disabled}
            >
              {messages.removeRelation}
            </Button>
          </Stack>
        </Card>
      ))}
      <Button
        variant="default"
        onClick={() =>
          form.insertListItem("relations", {
            rowId: crypto.randomUUID(),
            targetKind: "feature",
            target: null,
            type: "documents",
            description: "",
          })
        }
        disabled={disabled}
      >
        {messages.addRelation}
      </Button>
    </Stack>
  );
};
