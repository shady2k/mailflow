DO $$
BEGIN
  IF to_regcollation('mailflow_search') IS NULL THEN
    IF EXISTS (SELECT 1 FROM pg_collation WHERE collname = 'und-x-icu') THEN
      CREATE COLLATION mailflow_search FROM "und-x-icu";
    ELSE
      CREATE COLLATION mailflow_search FROM "C";
    END IF;
  END IF;
END $$;

-- The explicit RU map is also the fallback on PostgreSQL built without ICU.
CREATE OR REPLACE FUNCTION mailflow_search_fold(value text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN translate(lower(coalesce(value, '') COLLATE mailflow_search),
    'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ',
    'абвгдеёжзийклмнопрстуфхцчшщъыьэюя');

ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS body_index_last_run timestamptz;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS search_body_text text,
  ADD COLUMN IF NOT EXISTS body_indexed_at timestamptz,
  ADD COLUMN IF NOT EXISTS body_index_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS body_index_retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS body_index_lease_until timestamptz,
  ADD COLUMN IF NOT EXISTS body_index_error text;

CREATE OR REPLACE FUNCTION mailflow_reset_body_index() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.message_id IS DISTINCT FROM OLD.message_id
     OR (NEW.body_text IS DISTINCT FROM OLD.body_text OR NEW.body_html IS DISTINCT FROM OLD.body_html) THEN
    NEW.search_body_text := NULL;
    NEW.body_indexed_at := NULL;
    NEW.body_index_attempts := 0;
    NEW.body_index_retry_at := NULL;
    NEW.body_index_lease_until := NULL;
    NEW.body_index_error := NULL;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS messages_reset_body_index ON messages;
CREATE TRIGGER messages_reset_body_index BEFORE UPDATE ON messages
FOR EACH ROW EXECUTE FUNCTION mailflow_reset_body_index();
