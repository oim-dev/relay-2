import type { ReactElement } from "react";
import { Alert, Stack } from "@mantine/core";
import { useCommandDraft, useDraft, useEntity, errorMessage } from "domains/project";
import { EntityPicker } from "domains/knowledge";
import type { CreateKnowledgeProps } from "./types/create-knowledge-props.type";
import { KnowledgeEditor } from "../knowledge-editor/knowledge-editor";
import { messages } from "../../config/knowledge-screen.messages";
import { knowledgeEditorScope } from "../../helpers/editor-values";

/**
 * Выбирает приложение до начала редактирования новой реализации.
 *
 * Используется для:
 *  - фиксации CAS владельца состава при открытии формы создания
 */
export const CreateKnowledge = (props: CreateKnowledgeProps): ReactElement => {
  const application = useDraft<string | null>("knowledge-new-implementation-application", null);
  const query = useEntity(
    props.kind === "implementation" ? (application.value ?? undefined) : undefined,
  );
  const selectedApplication = props.kind === "implementation" ? application.value : null;
  const operation = useCommandDraft(knowledgeEditorScope(props.kind, null, selectedApplication));
  if (props.kind !== "implementation") {
    return (
      <KnowledgeEditor
        kind={props.kind}
        source={null}
        owner={null}
        onClose={props.onClose}
        onSaved={props.onSaved}
      />
    );
  }
  const canCreate = query.data?.entity.kind === "application";
  const hasError = query.error !== undefined;
  return (
    <Stack>
      <EntityPicker
        kind="application"
        label={messages.selectApplication}
        value={application.value}
        onChange={application.setValue}
        disabled={operation.uncertain}
      />
      {hasError && <Alert color="orange">{errorMessage(query.error)}</Alert>}
      {canCreate && query.data !== undefined && (
        <KnowledgeEditor
          key={query.data.entity.id}
          kind="implementation"
          source={null}
          owner={query.data}
          onClose={props.onClose}
          onSaved={props.onSaved}
        />
      )}
    </Stack>
  );
};
