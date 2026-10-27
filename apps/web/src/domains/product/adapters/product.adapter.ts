import type { ProjectEntity, EntityKind } from "@relay/contracts";
import { ENTITY_PAGE_SIZE } from "@relay/contracts";
import { readPage, writeCommands } from "domains/relay-data";
import { toProductState } from "../mappers/product-record";
import { productCommands } from "../helpers/product-commands";
import type { ProductCommand, ProductState } from "../types/product.type";

const snapshotKinds: readonly EntityKind[] = [
  "product",
  "feature",
  "scenario",
  "application",
  "implementation",
  "document",
];

/**
 * Собирает продуктовый экран из страниц текущего API, фиксируя generation первой.
 * Любое изменение между страницами отклоняет весь снимок как PAGE_CHANGED.
 * Загружает полные знания перечисленных видов; это цена старого общего экрана,
 * не ограниченная выдача. Задачи и история здесь не загружаются.
 */
export async function getProduct(projectId: string): Promise<ProductState> {
  let generation: number | undefined;
  const entities: ProjectEntity[] = [];
  for (const kind of snapshotKinds) {
    let offset: number | null = 0;
    while (offset !== null) {
      const page = await readPage(projectId, {
        kind,
        offset,
        limit: ENTITY_PAGE_SIZE.max,
        ...(generation === undefined ? {} : { generation }),
      });
      generation = page.generation;
      entities.push(...page.items);
      offset = page.nextOffset;
    }
  }
  if (generation === undefined) throw new Error("Не удалось получить поколение продукта.");
  return toProductState(projectId, generation, entities);
}

/**
 * Записывает предметные команды атомарно с исходными CAS снимка формы.
 * Автор, frozen request и восстановление receipt принадлежат общему writer.
 */
export async function saveProduct(
  projectId: string,
  command: ProductCommand,
  source: ProductState,
): Promise<{ id: string; revision: number }> {
  const result = await writeCommands(
    projectId,
    productCommands(command, source),
    command.requestId,
  );
  const saved = result.items.at(-1);
  if (!saved) throw new Error("Сервер не вернул результат сохранения продукта.");
  return { id: saved.id, revision: saved.revision };
}

/**
 * Сохраняет предметную диагностику и сообщение неопределённого исхода writer.
 */
export function productError(error: unknown): string {
  return error instanceof Error ? error.message : "Не удалось выполнить операцию. Ввод сохранён.";
}
