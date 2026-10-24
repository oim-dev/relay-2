import { componentStorageMessages } from "../components/component.messages";

/**
 * Первичные независимо версионируемые части. Очередь возвращается SQL-savepoint вместе с owner.
 * entity_refs — совместимая индексируемая проекция адресов, не второй источник назначений.
 */
export const COMPONENTS_SCHEMA = `
CREATE TABLE entity_components (
  owner_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('collection','task-criterion','task-dependency','task-related','task-target','plan-stage','plan-task','plan-scope','plan-participant','release-plan','document-relation','session-run','document-section','section-reservation','application-participation','address-assignment')),
  id TEXT NOT NULL CHECK(length(id)>0), identity_key TEXT NOT NULL, group_id TEXT NOT NULL,
  position TEXT NOT NULL CHECK(length(position)>0), version TEXT NOT NULL,
  parents_json TEXT NOT NULL CHECK(json_valid(parents_json) AND json_type(parents_json)='array'),
  deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),
  value TEXT NOT NULL CHECK(json_valid(value) AND json_type(value)='object'),
  completed_json TEXT GENERATED ALWAYS AS (CASE WHEN kind='task-criterion' THEN value -> '$.completed' END) STORED,
  target_id TEXT GENERATED ALWAYS AS (CASE WHEN kind IN ('task-dependency','task-related','plan-task') THEN json_extract(value,'$.taskId') END) STORED,
  CHECK(kind NOT IN ('task-criterion','plan-stage','session-run','document-section') OR (json_type(value,'$.id')='text' AND json_extract(value,'$.id')=id)),
  CHECK(kind!='collection' OR (json_type(value,'$.field')='text' AND json_extract(value,'$.field')=id)),
  CHECK(kind!='section-reservation' OR (json_type(value,'$.sectionId')='text' AND json_extract(value,'$.sectionId')=id)),
  PRIMARY KEY(owner_id,kind,id)
) STRICT;
CREATE INDEX components_owner_kind ON entity_components(owner_id,kind,deleted,position,id);
CREATE INDEX components_owner_version ON entity_components(owner_id,kind,id,version,position,deleted);
CREATE INDEX components_task_graph ON entity_components(owner_id,kind,deleted,position,id,completed_json,target_id);
CREATE UNIQUE INDEX components_active_identity ON entity_components(owner_id,kind,identity_key) WHERE deleted=0;
CREATE UNIQUE INDEX components_address_ref ON entity_components(json_extract(value,'$.ref')) WHERE kind='address-assignment' AND deleted=0;
CREATE INDEX components_membership_task ON entity_components(json_extract(value,'$.taskId'),owner_id) WHERE kind='plan-task' AND deleted=0;
CREATE TABLE component_changes (
  owner_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, before_json TEXT, after_json TEXT,
  PRIMARY KEY(owner_id,kind,id)
) STRICT;
CREATE TABLE component_events (sequence INTEGER PRIMARY KEY,owner_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,before_json TEXT,after_json TEXT) STRICT;
CREATE TABLE component_allocation_context(singleton INTEGER PRIMARY KEY CHECK(singleton=1),id TEXT) STRICT;
INSERT INTO component_allocation_context VALUES(1,NULL);
CREATE TABLE component_pending_versions(owner_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,before_version TEXT,
  PRIMARY KEY(owner_id,kind,id),FOREIGN KEY(owner_id,kind,id) REFERENCES entity_components(owner_id,kind,id) ON DELETE CASCADE) STRICT;
CREATE TRIGGER component_pending_insert AFTER INSERT ON entity_components WHEN NEW.kind='address-assignment' AND NEW.version='' BEGIN
  INSERT INTO component_pending_versions VALUES(NEW.owner_id,NEW.kind,NEW.id,NULL) ON CONFLICT(owner_id,kind,id) DO NOTHING;
END;
CREATE TRIGGER component_pending_remove AFTER UPDATE ON entity_components WHEN NEW.kind='address-assignment' AND NEW.deleted!=OLD.deleted BEGIN
  INSERT INTO component_pending_versions VALUES(NEW.owner_id,NEW.kind,NEW.id,OLD.version) ON CONFLICT(owner_id,kind,id) DO NOTHING;
END;
CREATE VIEW entity_refs AS SELECT json_extract(value,'$.ref') AS ref,owner_id AS entity_id
  FROM entity_components WHERE kind='address-assignment' AND deleted=0;
CREATE TRIGGER component_ref_insert INSTEAD OF INSERT ON entity_refs BEGIN
  INSERT INTO entity_components(owner_id,kind,id,identity_key,group_id,position,version,parents_json,deleted,value)
    VALUES(NEW.entity_id,'address-assignment',COALESCE((SELECT 'allocated:' || json_array(id,NEW.entity_id,'address-assignment',NEW.ref) FROM component_allocation_context WHERE singleton=1 AND id IS NOT NULL),lower(hex(randomblob(16)))),NEW.ref,'','V','','[]',0,json_object('ref',NEW.ref));
  INSERT INTO replication_address_queue SELECT NEW.ref,NEW.entity_id
    WHERE (SELECT importing FROM replication_state WHERE singleton=1)=0;
END;
CREATE TRIGGER component_ref_delete INSTEAD OF DELETE ON entity_refs BEGIN
  SELECT CASE WHEN (SELECT importing FROM replication_state WHERE singleton=1)=0 THEN RAISE(ABORT,'${componentStorageMessages.addressReserved}') END;
  UPDATE entity_components SET deleted=1 WHERE owner_id=OLD.entity_id AND kind='address-assignment'
    AND json_extract(value,'$.ref')=OLD.ref AND deleted=0;
END;
CREATE TRIGGER components_no_delete BEFORE DELETE ON entity_components
WHEN (SELECT importing FROM replication_state WHERE singleton=1)=0 BEGIN
  SELECT RAISE(ABORT,'${componentStorageMessages.tombstoneRequired}');
END;
CREATE TRIGGER components_immutable BEFORE UPDATE ON entity_components
WHEN NEW.owner_id!=OLD.owner_id OR NEW.kind!=OLD.kind OR NEW.id!=OLD.id OR NEW.identity_key!=OLD.identity_key
  OR (OLD.deleted=1 AND NEW.deleted=0 AND OLD.kind!='collection' AND (SELECT importing FROM replication_state WHERE singleton=1)=0)
  OR (OLD.kind IN ('address-assignment','section-reservation') AND NEW.value!=OLD.value)
  OR (OLD.kind IN ('task-dependency','task-related','task-target','plan-task','plan-scope','plan-participant','release-plan','application-participation') AND NEW.value!=OLD.value)
  OR (OLD.kind='document-relation' AND json_remove(NEW.value,'$.description')!=json_remove(OLD.value,'$.description'))
  OR (OLD.kind='section-reservation' AND NEW.deleted!=OLD.deleted AND (SELECT importing FROM replication_state WHERE singleton=1)=0)
  OR (OLD.kind='session-run' AND (NEW.deleted!=OLD.deleted
    OR (json_extract(OLD.value,'$.state')!='active' AND (NEW.value!=OLD.value OR NEW.position!=OLD.position) AND (SELECT importing FROM replication_state WHERE singleton=1)=0)
    OR json_remove(OLD.value,'$.state','$.endedAt','$.endReason')!=json_remove(NEW.value,'$.state','$.endedAt','$.endReason')))
BEGIN SELECT RAISE(ABORT,'${componentStorageMessages.immutableHistory}'); END;
CREATE TRIGGER components_insert AFTER INSERT ON entity_components
WHEN (SELECT importing FROM replication_state WHERE singleton=1)=0 BEGIN
  INSERT INTO component_changes VALUES(NEW.owner_id,NEW.kind,NEW.id,NULL,
    json_object('id',NEW.id,'kind',NEW.kind,'ownerId',NEW.owner_id,'position',NEW.position,'version',NEW.version,'parents',json(NEW.parents_json),'deleted',json(CASE NEW.deleted WHEN 1 THEN 'true' ELSE 'false' END),'value',json(NEW.value)))
    ON CONFLICT(owner_id,kind,id) DO UPDATE SET after_json=excluded.after_json;
  INSERT INTO component_events(owner_id,kind,id,before_json,after_json) SELECT owner_id,kind,id,NULL,after_json FROM component_changes WHERE owner_id=NEW.owner_id AND kind=NEW.kind AND id=NEW.id;
END;
CREATE TRIGGER components_update AFTER UPDATE ON entity_components
WHEN (SELECT importing FROM replication_state WHERE singleton=1)=0 BEGIN
  INSERT INTO component_changes VALUES(NEW.owner_id,NEW.kind,NEW.id,
    json_object('id',OLD.id,'kind',OLD.kind,'ownerId',OLD.owner_id,'position',OLD.position,'version',OLD.version,'parents',json(OLD.parents_json),'deleted',json(CASE OLD.deleted WHEN 1 THEN 'true' ELSE 'false' END),'value',json(OLD.value)),
    json_object('id',NEW.id,'kind',NEW.kind,'ownerId',NEW.owner_id,'position',NEW.position,'version',NEW.version,'parents',json(NEW.parents_json),'deleted',json(CASE NEW.deleted WHEN 1 THEN 'true' ELSE 'false' END),'value',json(NEW.value)))
    ON CONFLICT(owner_id,kind,id) DO UPDATE SET after_json=excluded.after_json;
  INSERT INTO component_events(owner_id,kind,id,before_json,after_json) VALUES(NEW.owner_id,NEW.kind,NEW.id,
    json_object('id',OLD.id,'kind',OLD.kind,'ownerId',OLD.owner_id,'position',OLD.position,'version',OLD.version,'parents',json(OLD.parents_json),'deleted',json(CASE OLD.deleted WHEN 1 THEN 'true' ELSE 'false' END),'value',json(OLD.value)),
    json_object('id',NEW.id,'kind',NEW.kind,'ownerId',NEW.owner_id,'position',NEW.position,'version',NEW.version,'parents',json(NEW.parents_json),'deleted',json(CASE NEW.deleted WHEN 1 THEN 'true' ELSE 'false' END),'value',json(NEW.value)));
END;
`;
