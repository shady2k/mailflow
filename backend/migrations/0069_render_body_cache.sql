ALTER TABLE messages ADD COLUMN IF NOT EXISTS body_render_cached_at timestamptz;

CREATE OR REPLACE FUNCTION mailflow_reset_render_cache() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.message_id IS DISTINCT FROM OLD.message_id
     OR ((NEW.body_text IS DISTINCT FROM OLD.body_text OR NEW.body_html IS DISTINCT FROM OLD.body_html)
         AND NEW.body_render_cached_at IS NOT DISTINCT FROM OLD.body_render_cached_at) THEN
    NEW.body_render_cached_at := NULL;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS messages_reset_render_cache ON messages;
CREATE TRIGGER messages_reset_render_cache BEFORE UPDATE ON messages
FOR EACH ROW EXECUTE FUNCTION mailflow_reset_render_cache();
