-- no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_subject_unicode_trgm
  ON messages USING gin ((mailflow_search_fold(subject) COLLATE mailflow_search) gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_sender_name_unicode_trgm
  ON messages USING gin ((mailflow_search_fold(from_name) COLLATE mailflow_search) gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_sender_email_unicode_trgm
  ON messages USING gin ((mailflow_search_fold(from_email) COLLATE mailflow_search) gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_body_unicode_trgm
  ON messages USING gin ((mailflow_search_fold(coalesce(search_body_text, body_text)) COLLATE mailflow_search) gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_body_index_pending
  ON messages (account_id, date DESC NULLS LAST, id) WHERE body_indexed_at IS NULL AND NOT is_deleted;
