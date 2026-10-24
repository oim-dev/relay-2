import { batchUpgradeV1Schema } from "./batch-receipt-v1-schema";

/**
 * Замороженная v2: независимый historical fixture, не импортирующий текущий production schema.
 */
export const componentsLegacyV2 =
  batchUpgradeV1Schema +
  `
CREATE TABLE batch_receipts(operation_key TEXT PRIMARY KEY NOT NULL,request_json TEXT NOT NULL,result_json TEXT NOT NULL) STRICT;
CREATE TRIGGER batch_receipts_no_update BEFORE UPDATE ON batch_receipts BEGIN SELECT RAISE(ABORT,'batch receipts are immutable'); END;
CREATE TRIGGER batch_receipts_no_delete BEFORE DELETE ON batch_receipts BEGIN SELECT RAISE(ABORT,'batch receipts are immutable'); END;
`;

/**
 * Замороженные таблицы и guards foundation-v3; source outbox не зависит от нового v4 DTO.
 */
export const componentsLegacyV3 =
  componentsLegacyV2 +
  `
CREATE TABLE replication_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),replica_id TEXT NOT NULL,sequence INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0,base_json TEXT,observed_json TEXT,importing INTEGER NOT NULL DEFAULT 0) STRICT;
INSERT INTO replication_state VALUES(1,'legacy-replica',7,7,NULL,NULL,0);
CREATE TABLE replication_entity_queue(id TEXT PRIMARY KEY,before_json TEXT,after_json TEXT) STRICT;
CREATE TABLE replication_address_queue(ref TEXT PRIMARY KEY,entity_id TEXT NOT NULL) STRICT;
CREATE TABLE replication_comment_queue(id TEXT PRIMARY KEY) STRICT;
CREATE TABLE replication_receipt_queue(operation_key TEXT PRIMARY KEY) STRICT;
CREATE TABLE replication_read_queue(owner TEXT PRIMARY KEY,entity_id TEXT NOT NULL,record_kind TEXT NOT NULL,version TEXT,changeset_id TEXT) STRICT;
CREATE TABLE replication_comment_order(id TEXT PRIMARY KEY REFERENCES task_comments(id),after_id TEXT) STRICT;
CREATE TABLE replication_outbox(id TEXT PRIMARY KEY,sequence INTEGER UNIQUE NOT NULL,json TEXT NOT NULL) STRICT;
CREATE TABLE replication_owner_heads(owner TEXT PRIMARY KEY,changeset_id TEXT NOT NULL) STRICT;
CREATE TABLE replication_conflicts(id TEXT PRIMARY KEY,json TEXT NOT NULL) STRICT;
CREATE TABLE replication_decisions(id TEXT PRIMARY KEY,json TEXT NOT NULL) STRICT;
CREATE TABLE replication_remapped_refs(ref TEXT PRIMARY KEY,previous_id TEXT NOT NULL,current_id TEXT NOT NULL) STRICT;
CREATE TABLE replication_entity_versions(entity_id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,version TEXT NOT NULL,parents_json TEXT NOT NULL) STRICT;
CREATE TRIGGER replication_outbox_no_update BEFORE UPDATE ON replication_outbox BEGIN SELECT RAISE(ABORT,'replication changesets are immutable'); END;
CREATE TRIGGER replication_address_insert AFTER INSERT ON entity_refs WHEN (SELECT importing FROM replication_state WHERE singleton=1)=0 BEGIN INSERT OR IGNORE INTO replication_address_queue VALUES(NEW.ref,NEW.entity_id); END;
DROP TRIGGER entities_immutable;
CREATE TRIGGER entities_immutable BEFORE UPDATE ON entities WHEN NEW.id!=OLD.id OR NEW.kind!=OLD.kind OR NEW.created_at!=OLD.created_at OR NEW.created_by!=OLD.created_by OR (NEW.revision!=OLD.revision+1 AND NOT((SELECT importing FROM replication_state WHERE singleton=1)=1 AND NEW.revision=OLD.revision)) BEGIN SELECT RAISE(ABORT,'immutable identity'); END;
DROP TRIGGER entities_update;
CREATE TRIGGER entities_update AFTER UPDATE ON entities WHEN (SELECT importing FROM replication_state WHERE singleton=1)=0 BEGIN INSERT INTO entity_refs(ref,entity_id) SELECT NEW.key,NEW.id WHERE NOT EXISTS(SELECT 1 FROM entity_refs WHERE ref=NEW.key AND entity_id=NEW.id); UPDATE project_state SET generation=generation+1 WHERE singleton=1; END;
`;
