import type { ComponentKind, EntityKind } from "@relay/contracts";
import { ENTITY_DEFINITIONS } from "./entity-definitions";
import { COMPONENT_DEFINITIONS } from "./component-definitions";
import type { RelationalTableDescriptor } from "./catalog.types";

/**
 * Каталог фактических первичных таблиц; readonly views и локальные очереди здесь не перечисляются.
 * task_comments переносится целиком; локальный sequence находится в самостоятельной таблице.
 */
export const RELATIONAL_TABLES: readonly RelationalTableDescriptor[] = [
  { name: "object_ids", primaryKey: ["id"], portable: true },
  ...Object.entries(ENTITY_DEFINITIONS).map(([kind, definition]) => ({
    name: definition.table,
    primaryKey: ["id"],
    portable: true,
    // Ключи объекта закрыты satisfies Record<EntityKind,...>.
    entityKind: kind as EntityKind,
  })),
  ...Object.entries(COMPONENT_DEFINITIONS).map(([kind, definition]) => ({
    name: definition.table,
    primaryKey: ["owner_id", "id"],
    portable: true,
    // Ключи объекта закрыты satisfies Record<ComponentKind,...>.
    componentKind: kind as ComponentKind,
  })),
  { name: "checkpoint_references", primaryKey: ["checkpoint_id", "target_id"], portable: true },
  {
    name: "checkpoint_acceptances",
    primaryKey: ["checkpoint_id", "child_session_id"],
    portable: true,
  },
  { name: "task_comments", primaryKey: ["id"], portable: true },
  { name: "replication_entity_versions", primaryKey: ["entity_id"], portable: true },
  { name: "batch_receipts", primaryKey: ["operation_key"], portable: true },
  { name: "replication_confirmations", primaryKey: ["replica_id"], portable: true },
  { name: "replication_publications", primaryKey: ["id"], portable: true },
  { name: "local_entity_revisions", primaryKey: ["entity_id"], portable: false },
  { name: "local_comment_sequences", primaryKey: ["comment_id"], portable: false },
];
