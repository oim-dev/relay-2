import type { Database } from "bun:sqlite";
import { sqliteMessages } from "../sqlite/sqlite.messages";
import { entityMessages } from "./entity.messages";

/**
 * Общий SQL-источник логического append-only журнала. t содержит carrier только для непарного UTF-16.
 * Алиасы c/t принадлежат SQL-владельцам Storage, не пользовательскому вводу.
 */
export const TASK_COMMENT_SOURCE =
  "task_comments c LEFT JOIN replication_comment_text t ON t.comment_id=c.id";

/**
 * Точный TaskComment JSON. json(carrier) не извлекает surrogate в plainTEXT и не теряет code units.
 * Обычные title/body берутся из прежних колонок; nullable carrier означает отсутствие fallback.
 */
export const TASK_COMMENT_JSON = `json_object('id',c.id,
  'title',json(CASE WHEN (c.text_encoding & 1)!=0 THEN t.title_json ELSE json_quote(c.title) END),
  'body',json(CASE WHEN (c.text_encoding & 2)!=0 THEN t.body_json ELSE json_quote(c.body) END),
  'createdAt',c.created_at,'createdBy',c.created_by)`;

/**
 * Один источник защиты логического immutable payload для fresh create и сохраняющей миграции.
 * Encoding mask принадлежит первоначальному INSERT, sidecar не может задним числом заменить plain text.
 */
export const COMMENT_TEXT_GUARDS = `
CREATE TRIGGER IF NOT EXISTS task_comments_payload_immutable BEFORE UPDATE ON task_comments
WHEN NEW.id!=OLD.id OR NEW.task_id!=OLD.task_id OR NEW.title!=OLD.title OR NEW.body!=OLD.body
  OR NEW.created_at!=OLD.created_at OR NEW.created_by!=OLD.created_by OR NEW.text_encoding!=OLD.text_encoding
BEGIN SELECT RAISE(ABORT,'${sqliteMessages.appendOnlyConstraint}'); END;
CREATE TRIGGER IF NOT EXISTS replication_comment_text_insert_guard BEFORE INSERT ON replication_comment_text
WHEN NOT EXISTS(SELECT 1 FROM task_comments c WHERE c.id=NEW.comment_id
  AND ((NEW.title_json IS NOT NULL AND (c.text_encoding & 1)!=0 AND c.title='') OR (NEW.title_json IS NULL AND (c.text_encoding & 1)=0))
  AND ((NEW.body_json IS NOT NULL AND (c.text_encoding & 2)!=0 AND c.body='') OR (NEW.body_json IS NULL AND (c.text_encoding & 2)=0)))
BEGIN SELECT RAISE(ABORT,'${entityMessages.invalidCommentEncoding}'); END;
CREATE TRIGGER IF NOT EXISTS replication_comment_text_no_update BEFORE UPDATE ON replication_comment_text
BEGIN SELECT RAISE(ABORT,'${sqliteMessages.appendOnlyConstraint}'); END;
CREATE TRIGGER IF NOT EXISTS replication_comment_text_no_delete BEFORE DELETE ON replication_comment_text
WHEN (SELECT importing FROM replication_state WHERE singleton=1)=0
BEGIN SELECT RAISE(ABORT,'${sqliteMessages.appendOnlyConstraint}'); END;
`;

/**
 * Дополняет legacy comments технической маской без изменения title/body/авторства и устанавливает guards.
 * Таблица carrier уже создана владельцем replication schema; вызывающий удерживает migration transaction.
 */
export function upgradeCommentTextStorage(connection: Database): void {
  const columns = connection.query<{ name: string }, []>("PRAGMA table_info(task_comments)").all();
  if (!columns.some((column) => column.name === "text_encoding")) {
    connection.exec(
      "ALTER TABLE task_comments ADD COLUMN text_encoding INTEGER NOT NULL DEFAULT 0 CHECK(text_encoding BETWEEN 0 AND 3)",
    );
  }
  connection.exec(COMMENT_TEXT_GUARDS);
}
