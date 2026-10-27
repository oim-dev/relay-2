import { TASK_COLUMNS } from "@relay/contracts";
import { relayClient } from "infra/tasks-api";
import { readEntity } from "domains/relay-data";

/**
 * Представление текущей колонки Core в каркасе проекта.
 */
export interface TaskStatus {
  /* Ключ колонки Core. */
  id: string;
  /* Человеческая подпись. */
  label: string;
  /* Визуальная категория темы. */
  color: string;
  /* Завершённая либо отменённая колонка. */
  isTerminal: boolean;
  /* Колонка done; не заменяет фактическую готовность. */
  isSuccessful: boolean;
}

/**
 * Проект и автор текущего сервера, без пользовательских путей файловой системы.
 */
export interface Project {
  /* Статус Git Sync предоставляется отдельной проекцией Runtime. */
  hasBackgroundSynchronization: boolean;
  /* Постоянный ID. */
  id: string;
  /* Имя проекта. */
  name: string;
  /* Автор Server. */
  actor: string;
  /* HTTP не предоставляет путь к конфигурации. */
  configPath: string;
  /* Колонка новой задачи. */
  defaultStatus: string;
  /* Колонки очереди, а не вычисляемая готовность. */
  readyStatuses: string[];
  /* Штатные колонки Core. */
  statuses: TaskStatus[];
}

const labels = {
  inbox: "Входящие",
  ready: "К выполнению",
  "in-progress": "В работе",
  review: "На проверке",
  done: "Готово",
  cancelled: "Отменено",
};

/**
 * Читает актуальный паспорт проекта и контекст автора без прежней конфигурации статусов.
 */
export async function getProject(projectId: string): Promise<Project> {
  const [entity, context] = await Promise.all([
    readEntity(projectId, projectId),
    relayClient.context(),
  ]);
  if (entity.kind !== "project") throw new Error("Сервер вернул другой вид вместо проекта.");
  return {
    id: entity.id,
    name: entity.data.name,
    actor: context.data.actor,
    configPath: "",
    hasBackgroundSynchronization: true,
    defaultStatus: "inbox",
    readyStatuses: ["ready"],
    statuses: TASK_COLUMNS.map((id) => ({
      id,
      label: labels[id],
      color: "gray",
      isTerminal: id === "done" || id === "cancelled",
      isSuccessful: id === "done",
    })),
  };
}
