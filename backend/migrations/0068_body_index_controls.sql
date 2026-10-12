ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS body_index_paused boolean NOT NULL DEFAULT false;

-- The old scheduler recorded normal local deferrals as provider failures.
UPDATE messages SET body_index_error = NULL, body_index_attempts = 0, body_index_retry_at = NULL
WHERE body_indexed_at IS NULL AND body_index_error = 'Provider temporarily limiting background connections';
