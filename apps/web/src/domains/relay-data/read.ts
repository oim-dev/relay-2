import type { HttpEntityQuery, HttpEntityPage, ProjectEntity } from "@relay/contracts";
import { relayClient } from "infra/tasks-api";
import { dataMessages } from "./relay-data.messages";

/**
 * Читает адресованную карточку. Её revision является исходным guard формы.
 */
export async function readEntity(project: string, ref: string): Promise<ProjectEntity> {
  return (await relayClient.entity(project, ref, { withVersions: true })).data;
}

/**
 * Читает ограниченное окно. Продолжение передаёт generation исходной страницы.
 */
export async function readPage(project: string, query: HttpEntityQuery): Promise<HttpEntityPage> {
  return (await relayClient.entities(project, query)).data;
}

/**
 * Преобразует непрозрачную для старых виджетов строку в текущее поколение списка.
 */
export function pageGeneration(version: string | undefined): number | undefined {
  if (version === undefined) {
    return undefined;
  }
  const generation = Number(version);
  if (!/^\d+$/.test(version) || !Number.isSafeInteger(generation) || generation < 0) {
    throw new Error(dataMessages.invalidVersion);
  }
  return generation;
}
