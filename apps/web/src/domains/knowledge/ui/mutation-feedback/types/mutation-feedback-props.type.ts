import type { CommandDraft } from "domains/project";
/**
 * Исход команды без доступа к её внутреннему хранилищу.
 */
export type MutationFeedbackProps = Pick<CommandDraft, "error" | "uncertain" | "pending">;
