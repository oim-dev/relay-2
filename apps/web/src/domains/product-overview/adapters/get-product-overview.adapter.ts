import { relayClient, RelayApiError, getStorageFailureMessage } from "infra/tasks-api";
import {
  ProductOverviewDomainError,
  createInvalidResponseError,
  createSnapshotChangedError,
  createProjectUnavailableError,
  createStorageMaintenanceError,
  createTemporarilyUnavailableError,
} from "../errors/product-overview.error";
import type { ProductOverview } from "../types/product-overview.type";
import { readOverviewSources } from "./overview-sources";
import { readOverviewPreviews } from "./overview-previews";
import { overviewScene } from "../mappers/overview-scene";
import { requireOverviewGeneration } from "../helpers/overview-generation";

/**
 * Читает агрегат и bounded подборки текущего API. Поколения страниц и контрольное
 * чтение защищают состав от смешения состояний; отказ сохраняет прежний обзор в SWR.
 */
export async function getProductOverview(projectId: string): Promise<ProductOverview> {
  let projectWasRead = false;
  try {
    const { data: overview } = await relayClient.overview(projectId);
    projectWasRead = true;
    const sources = await readOverviewSources(projectId, overview);
    const details = await readOverviewPreviews(projectId, sources);
    const final = await relayClient.read(projectId, "projectStatus", {});
    requireOverviewGeneration(overview.generation, final.data.generation);
    return overviewScene(overview, sources, details);
  } catch (error) {
    if (error instanceof ProductOverviewDomainError) throw error;
    if (error instanceof RelayApiError && error.code === "PAGE_CHANGED")
      throw createSnapshotChangedError(error);
    if (!projectWasRead && error instanceof RelayApiError && error.status === 404)
      throw createProjectUnavailableError(error);
    const storage = getStorageFailureMessage(error);
    if (storage !== null) throw createStorageMaintenanceError(storage, error);
    if (error instanceof RelayApiError || error instanceof TypeError)
      throw createTemporarilyUnavailableError(error);
    throw createInvalidResponseError(error);
  }
}
