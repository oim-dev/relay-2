import { statSync } from "node:fs";
import { ENTITY_KINDS, type ProjectEntity } from "@relay/contracts";
import type { ProjectDatabase } from "@relay/storage";
import { EntityReader } from "../projections/entity-reader";
import { checkProjectIntegrity } from "./queries-doctor";
import { readProjectOverview } from "./queries-overview";
import { parseEntitySearch, searchProjectEntities } from "./queries-search";
import type { ProjectCheck, ProjectOverview, ProjectStatus } from "./queries.types";

export type { ProjectCheck, ProjectOverview } from "./queries.types";

/**
 * Согласованные чтения проекта: адресация, поиск, обзор и диагностика целостности.
 * Каждый составной сценарий удерживает единый snapshot и не изменяет данные проекта.
 */
export class QueryService {
  /* Поддерживаемые виды сущностей из общего переносимого контракта. */
  static readonly kinds = ENTITY_KINDS;
  /* Соединение выбранного проекта; открытием и закрытием владеет вызывающее приложение. */
  private readonly db: ProjectDatabase;

  /**
   * Привязывает сценарии чтения к открытому соединению без изменения его срока жизни.
   */
  constructor(db: ProjectDatabase) {
    this.db = db;
  }

  /**
   * Разрешает адрес и декодирует карточку с зависимыми данными в одном снимке.
   * Неизвестный адрес даёт NOT_FOUND, повреждённая карточка — CORRUPT_DATA.
   */
  get(ref: string): ProjectEntity {
    return this.db.snapshot(() => new EntityReader(this.db).get(ref));
  }

  /**
   * Ищет точный адрес и подстроку предметного содержания в едином снимке проекта.
   * Читает и проверяет весь выбранный вид до фильтрации; ошибки хранения не скрываются.
   * Поле kind ограничивает вид, q должно быть непустой строкой; остальные поля запрещены.
   */
  search(input: Readonly<Record<string, unknown>>): ProjectEntity[] {
    const request = parseEntitySearch(input);
    return this.db.snapshot(() => searchProjectEntities(this.db, request));
  }

  /**
   * Возвращает полный проверенный состав, счётчики и готовность задач одного снимка.
   * Полный список читается один раз; граф задач рассчитывается по этому же составу.
   */
  overview(): ProjectOverview {
    return this.db.snapshot(() => readProjectOverview(this.db));
  }

  /**
   * Читает поколение и число записей в общем снимке без загрузки JSON и комментариев.
   * Размер основного файла берётся отдельно из файловой системы и не включает WAL/SHM.
   */
  status(): ProjectStatus {
    return this.db.snapshot(() => ({
      projectId: this.db.projectId,
      databasePath: this.db.path,
      bytes: statSync(this.db.path).size,
      generation: this.db.getGeneration(),
      records: this.db.count(),
    }));
  }

  /**
   * Проверяет полные карточки, структурированные ссылки и граф обязательств одного снимка.
   * Нарушения собираются в INTEGRITY_ERROR; неожиданные ошибки пробрасываются без исправления БД.
   */
  check(): ProjectCheck {
    return this.db.snapshot(() => checkProjectIntegrity(this.db));
  }
}
