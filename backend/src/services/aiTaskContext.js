import { randomUUID } from 'node:crypto';
import { query } from './db.js';
// Stable context for a pending background summary. Atomic row update preserves
// the first UUID across concurrent workers/restarts and remains account-scoped.
// The caller clears aiSummarySessionId when the pending job succeeds.
export function createMessageAiContextStore(queryFn) {
  return async function getMessageAiTaskContext(accountId, messageId, pluginId) {
    const { rows } = await queryFn(`UPDATE messages SET plugin_annotations = jsonb_set(
    coalesce(plugin_annotations, '{}'::jsonb), ARRAY[$3::text],
    coalesce(plugin_annotations -> $3, '{}'::jsonb) || jsonb_build_object('aiSummarySessionId',
      CASE WHEN plugin_annotations -> $3 ->> 'aiSummarySessionId' ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN plugin_annotations -> $3 ->> 'aiSummarySessionId' ELSE $4::text END), true)
    WHERE account_id = $1 AND id = $2 AND NOT is_deleted
      AND nullif(plugin_annotations -> $3 ->> 'gist', '') IS NULL
    RETURNING plugin_annotations -> $3 ->> 'aiSummarySessionId' AS session_id`,
    [accountId, messageId, pluginId, randomUUID()]);
    return rows[0] ? { sessionId: rows[0].session_id } : null;
  };
}
export const getMessageAiTaskContext = createMessageAiContextStore(query);
