import { snippetFromBody } from './messageParser.js';

// Keyset pagination visits unrenderable bodies once per pass, without IMAP I/O.
export async function backfillCachedSnippets(query, { after = null, batchSize = 100, maxBatches = 10 } = {}) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500 || !Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > 100) throw new Error('Invalid batch bounds');
  const result = { scanned: 0, updated: 0, empty: 0, changed: 0, batches: 0, after, complete: false };
  for (let batch = 0; batch < maxBatches; batch++) {
    const { rows } = await query(`SELECT id, account_id, uid, folder, message_id, body_text, body_html
      FROM messages WHERE NOT is_deleted AND COALESCE(snippet, '') = ''
        AND (body_text IS NOT NULL OR body_html IS NOT NULL)
        AND ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id LIMIT $2`, [result.after, batchSize]);
    if (!rows.length) { result.complete = true; break; }
    result.batches++;
    for (const row of rows) {
      result.scanned++;
      const snippet = snippetFromBody(row.body_text, row.body_html).replace(/\0/g, '');
      if (!snippet) result.empty++;
      else {
        const update = await query(`UPDATE messages SET snippet = $1
          WHERE id = $2 AND account_id = $3 AND uid = $4 AND folder = $5
            AND message_id IS NOT DISTINCT FROM $6 AND NOT is_deleted
            AND body_text IS NOT DISTINCT FROM $7 AND body_html IS NOT DISTINCT FROM $8
            AND COALESCE(snippet, '') = '' RETURNING id`,
        [snippet, row.id, row.account_id, row.uid, row.folder, row.message_id, row.body_text, row.body_html]);
        if (update.rows.length) result.updated++;
        else result.changed++;
      }
      result.after = row.id;
    }
    if (rows.length < batchSize) { result.complete = true; break; }
  }
  return result;
}
