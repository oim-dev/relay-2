/**
 * Транзакционные очереди typed частей для outer outbox и последовательных command boundaries.
 * Предметные значения находятся только в relational таблицах; JSON здесь — before/after текущей записи.
 */
export const COMPONENTS_SCHEMA = `
CREATE TABLE component_changes (
  owner_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, before_json TEXT, after_json TEXT,
  PRIMARY KEY(owner_id,kind,id)
) STRICT;
CREATE TABLE component_events (
  sequence INTEGER PRIMARY KEY,owner_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,
  before_json TEXT,after_json TEXT
) STRICT;
`;
