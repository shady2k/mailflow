import { query } from './db.js';
import { STATUS_STALE_MS } from './folderStatus.js';

export async function getUnreadCountSnapshot(userId) {
  const { rows } = await query(`SELECT a.id AS account_id, a.include_in_unified_inbox,
      f.server_unread_count AS count, f.server_total_count, f.server_counts_at,
      f.server_count_revision, f.status_attempt_revision, f.status_error,
      u.preferences->'showAppBadge' IS DISTINCT FROM 'false'::jsonb AS show_app_badge,
      (SELECT last_value::text FROM folder_status_revision) AS barrier_revision
    FROM users u LEFT JOIN email_accounts a ON a.user_id=u.id AND a.enabled
    LEFT JOIN folders f ON f.account_id=a.id AND f.path='INBOX'
    WHERE u.id=$1`, [userId]);
  const byAccount = {}, snapshots = {};
  let total = 0, complete = rows.length > 0;
  for (const row of rows) {
    if (!row.account_id) continue;
    const known = row.count != null && row.server_counts_at != null;
    const count = known ? Number(row.count) : null;
    const stale = !known || !!row.status_error || Date.now() - new Date(row.server_counts_at).getTime() > STATUS_STALE_MS;
    byAccount[row.account_id] = count;
    snapshots[row.account_id] = { totalCount: known && row.server_total_count != null ? Number(row.server_total_count) : null,
      revision: row.server_count_revision || '0', attemptRevision: row.status_attempt_revision || row.server_count_revision || '0',
      observedAt: row.server_counts_at || null, stale, known };
    if (row.include_in_unified_inbox !== false) {
      if (known) total += count;
      if (stale) complete = false;
    }
  }
  return { schemaVersion: 1, kind: 'inbox-unread', userId, showAppBadge: rows[0]?.show_app_badge !== false,
    barrierRevision: rows[0]?.barrier_revision ?? null, total, byAccount, snapshots, complete };
}

// Recovery needs proof of a sample started after its request, not just a recently cached count.
export async function getFreshUnreadCountSnapshot(userId, refreshAccount) {
  const { rows: [watermark] } = await query("SELECT last_value::text AS revision FROM folder_status_revision");
  const { rows: accounts } = await query("SELECT * FROM email_accounts WHERE user_id=$1 AND enabled AND protocol='imap'", [userId]);
  await Promise.allSettled(accounts.map(account => refreshAccount(account)));
  const snapshot = await getUnreadCountSnapshot(userId);
  for (const value of Object.values(snapshot.snapshots)) {
    value.recoveryBarrierRevision = watermark.revision;
  }
  return { ...snapshot, recoveryBarrierRevision: watermark.revision };
}
