import { useEffect, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import type { BatchResult, NamedCommand } from "@relay/contracts";
import { useProject } from "../project-context";
import { errorMessage, isUncertainCommandError } from "../command-failure";
import { useDraft } from "./draft.hooks";
import type { CommandDraft, CommandDraftValue, ProjectCommand } from "../types/project.types";
import { invalidateProjectPages } from "../operations/invalidation";
import { executeProjectCommand, recoverProjectCommand } from "../operations/execute-command";

/**
 * Связывает исполнение команды с GET-кешем исходного server/project.
 * Смена маршрута не меняет адрес инвалидирования и не завершает новую форму.
 */
export function useCommand(): ProjectCommand {
  const scope = useProject();
  const { mutate } = useSWRConfig();
  const [pending, setPending] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /**
   * Ожидает исходный ключ, затем обновляет только серверные чтения его проекта.
   */
  async function acceptResult(operation: Promise<BatchResult>): Promise<BatchResult> {
    if (alive.current) {
      setPending(true);
    }
    try {
      const result = await operation;
      invalidateProjectPages(scope);
      void mutate(
        (key) => Array.isArray(key) && key[0] === scope.serverKey && key[1] === scope.projectId,
      );
      return result;
    } finally {
      if (alive.current) {
        setPending(false);
      }
    }
  }
  /**
   * Исполняет frozen команду через общий адаптер ключей и receipt replay.
   */
  async function execute(command: NamedCommand, operationKey: string): Promise<BatchResult> {
    return await acceptResult(executeProjectCommand(scope, command, operationKey));
  }
  /**
   * Подтверждает только квитанцию: текущий статус сущности не участвует в выборе исхода.
   */
  async function recover(operationKey: string): Promise<BatchResult> {
    return await acceptResult(recoverProjectCommand(scope, operationKey));
  }
  return { execute, recover, pending };
}

/**
 * Владеет frozen командой формы и её ключом, сохраняя draft при конфликте и обрыве.
 * Размонтированная форма не завершает новый экземпляр пользовательского действия.
 */
export function useCommandDraft(name: string): CommandDraft {
  const draft = useDraft<CommandDraftValue>(`command:${name}`, { uncertain: false });
  const command = useCommand();
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  /**
   * Снимает только окончательную ошибку; ожидающий или неопределённый запрос сохраняется.
   */
  function reset(): void {
    if (!draft.value.uncertain && !inFlight.current) {
      draft.reset();
    }
  }

  /**
   * Проверяет существующую receipt через GET, без создания ключа или повторной записи.
   * Возвращает результат только текущему владельцу; отказ сохраняет исходный draft.
   */
  async function recover(): Promise<BatchResult | undefined> {
    const original = draft.value;
    if (inFlight.current || original.operationKey === undefined) {
      return undefined;
    }
    inFlight.current = true;
    try {
      const result = await command.recover(original.operationKey);
      if (!alive.current) {
        return undefined;
      }
      draft.reset();
      return result;
    } catch (error) {
      if (alive.current) {
        draft.setValue({ ...original, uncertain: true, error: errorMessage(error) });
      }
      return undefined;
    } finally {
      inFlight.current = false;
    }
  }

  /**
   * Выдаёт ключ только новому действию. При неизвестном исходе использует frozen запрос,
   * а поздний результат размонтированного владельца не завершает новую форму.
   */
  async function submit(next: NamedCommand): Promise<BatchResult | undefined> {
    if (inFlight.current) {
      return undefined;
    }
    inFlight.current = true;
    const frozen = draft.value.command ?? structuredClone(next);
    const operationKey = draft.value.operationKey ?? crypto.randomUUID();
    draft.setValue({ command: frozen, operationKey, uncertain: true });
    try {
      const result = await command.execute(frozen, operationKey);
      if (!alive.current) {
        return undefined;
      }
      draft.reset();
      return result;
    } catch (error) {
      if (alive.current) {
        const uncertain = isUncertainCommandError(error);
        draft.setValue({
          ...(uncertain ? { command: frozen, operationKey } : {}),
          uncertain,
          error: errorMessage(error),
        });
      }
      return undefined;
    } finally {
      inFlight.current = false;
    }
  }

  return {
    pending: command.pending,
    uncertain: draft.value.uncertain,
    error: draft.value.error,
    reset,
    recover,
    submit,
  };
}
