import {
  ENTITY_KINDS,
  validateEntityReadRequest,
  type EntityReadOptions,
  type EntityReadResult,
  type ProjectEntity,
  type VersionedEntityReadResult,
} from "@relay/contracts";
import type { ProjectStore } from "@relay/storage";
import { EntityReader } from "../projections/entity-reader";
import { checkProjectIntegrity } from "./queries-doctor";
import { readEntitySelection } from "./queries-get";
import { readVersionedEntitySelection } from "./queries-get-versioned";
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
  private readonly db: ProjectStore;

  /**
   * Привязывает сценарии чтения к открытому соединению без изменения его срока жизни.
   */
  constructor(db: ProjectStore) {
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
   * Читает от 1 до 200 адресов в общем снимке с поколением, сохраняя порядок и повторы.
   * По умолчанию возвращает полные предметные записи; summary выбирает только краткие SQL-поля.
   * Адресные ошибки остаются элементами результата, инфраструктурные прерывают вызов.
   * Полный проект не загружается; для документов один раз читается паспорт с каталогом разделов.
   */
  getMany(refs: readonly string[], options: EntityReadOptions = {}): EntityReadResult {
    validateEntityReadRequest(refs, options);
    return this.db.snapshot(() => readEntitySelection(this.db, refs, options));
  }

  /**
   * Асинхронно читает тот же full/summary набор и отдельные переносимые версии успешных ID.
   * Адреса, содержание, версии и поколение относятся к одному anchor; смена контекста прерывает вызов.
   * До I/O проверяет форму запроса; summary не загружает тела, комментарии или паспорт проекта.
   */
  async getManyVersioned(
    refs: readonly string[],
    options: EntityReadOptions = {},
  ): Promise<VersionedEntityReadResult> {
    validateEntityReadRequest(refs, options);
    return await readVersionedEntitySelection(this.db.commands, refs, options);
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
      ...this.db.storageInfo(),
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
