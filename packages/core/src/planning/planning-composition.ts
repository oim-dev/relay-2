import {
  RelayError,
  type EntityRecord,
  type PlanningCompositionPageRequest,
} from "@relay/contracts";
import type { ProjectDatabase } from "@relay/storage";
import { entityMessages } from "../entities/entity.messages";

/**
 * Проверяет постоянные ID всего состава и читает только полные карточки заданного окна.
 * Вызывающий удерживает снимок владельца и заранее проверяет границы окна.
 * Отсутствующая ссылка или чужой вид дают прежний NOT_FOUND даже вне окна;
 * исчезновение уже проверенной записи считается CORRUPT_DATA.
 */
export function readCompositionWindow(
  db: ProjectDatabase,
  ids: readonly string[],
  kind: "task" | "work-plan",
  request: Readonly<PlanningCompositionPageRequest>,
): EntityRecord[] {
  const identities = new Set(db.getManyIdentities(ids, kind).map((identity) => identity.id));
  for (const id of ids) {
    if (!identities.has(id)) {
      throw new RelayError("NOT_FOUND", entityMessages.recordNotFound, 3, { ref: id, kind });
    }
  }
  const window = ids.slice(request.offset, request.offset + request.limit);
  const records = new Map(db.getMany(window, kind).map((record) => [record.id, record]));
  return window.map((id) => {
    const record = records.get(id);
    if (!record) {
      throw new RelayError("CORRUPT_DATA", entityMessages.missingResolvedRecord, 1, { id });
    }
    return record;
  });
}
