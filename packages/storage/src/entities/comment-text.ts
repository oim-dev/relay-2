/**
 * Readonly проекция переносимого журнала с локальным порядком отображения.
 * sequence не переносится и не хранится второй копией в task_comments.
 */
export const TASK_COMMENT_SOURCE = `(SELECT c.*,s.sequence FROM task_comments c
  JOIN local_comment_sequences s ON s.comment_id=c.id) c`;

/**
 * Точный TaskComment JSON из единственного plain/carrier слота каждого текста.
 * JSON-string carrier не извлекается в lossy UTF-8 TEXT, поэтому code units сохраняются.
 */
export const TASK_COMMENT_JSON = `json_object('id',c.id,
  'title',json(coalesce(c.title_json,json_quote(c.title))),
  'body',json(coalesce(c.body_json,json_quote(c.body))),
  'createdAt',c.created_at,'createdBy',c.created_by)`;
