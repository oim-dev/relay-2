import { BATCH_RECEIPT_SCHEMA } from "./batch-schema";
import { REPLICATION_SCHEMA } from "./replication-schema";
import { COMPONENTS_SCHEMA } from "./components-schema";
import { COMMAND_SCHEMA } from "./command-schema";
import { SYNCHRONIZATION_SCHEMA } from "../synchronization/schedule";
import { ENTITY_SCHEMA } from "../relational/entity-schema";
import { COMPONENT_SCHEMA } from "../relational/component-schema";
import { HISTORY_SCHEMA } from "../relational/history-schema";
import { JOURNAL_SCHEMA, PORTABLE_REPLICATION_SCHEMA } from "../relational/journal-schema";
import { RELATIONAL_PROJECTIONS } from "../relational/projections";
import { QUERY_PROJECTIONS } from "../relational/query-projections";

export const SCHEMA_VERSION = 6;
export const APPLICATION_ID = 0x524c5932;

/**
 * Чистая предметная схема: typed primary tables, отдельный local CAS и только readonly compatibility views.
 * Прежние схемы не преобразуются; проверка совместимости до DDL принадлежит ProjectDatabase.open.
 * Служебные JSON-журналы описывают неизменяемые протоколы, а не первичное содержание владельцев.
 */
export const SCHEMA =
  ENTITY_SCHEMA +
  COMPONENT_SCHEMA +
  HISTORY_SCHEMA +
  JOURNAL_SCHEMA +
  PORTABLE_REPLICATION_SCHEMA +
  BATCH_RECEIPT_SCHEMA +
  REPLICATION_SCHEMA +
  COMPONENTS_SCHEMA +
  COMMAND_SCHEMA +
  SYNCHRONIZATION_SCHEMA +
  RELATIONAL_PROJECTIONS +
  QUERY_PROJECTIONS;
