export function foldedMatch(expression, index) {
  return `(mailflow_search_fold(${expression}) COLLATE mailflow_search) LIKE mailflow_search_fold($${index}) COLLATE mailflow_search`;
}

export function freeTextTermCondition(likeIdx) {
  return `(${['m.from_name', 'm.from_email', 'm.subject', 'coalesce(m.search_body_text, m.body_text)'].map(column => foldedMatch(column, likeIdx)).join(' OR ')})`;
}

export function searchRowsSQL(conditions, limitIndex) {
  // Preserve repeated deliveries within each folder. Only equivalent, verified
  // bodies across folder views are paired, one instance at a time.
  return `
      WITH candidates AS (SELECT m.*,
        CASE WHEN m.body_indexed_at IS NOT NULL AND m.message_id <> '' THEN m.message_id ELSE m.id::text END AS copy_key,
        row_number() OVER (PARTITION BY m.account_id, m.folder, m.message_id,
          m.search_body_text, m.subject, m.from_email, m.date ORDER BY m.id) AS folder_instance
      FROM messages m WHERE m.account_id = ANY($1) AND NOT m.is_deleted
        AND ${conditions.join(' AND ')}),
      matched AS (SELECT
        row_number() OVER (PARTITION BY m.account_id, m.copy_key, m.search_body_text,
          m.subject, m.from_email, m.date, m.folder_instance
          ORDER BY (m.folder = 'INBOX') DESC, m.date DESC, m.id) AS copy_rank,
        m.id, m.uid, m.folder, m.message_id, m.subject, m.from_name, m.from_email,
        m.to_addresses, m.cc_addresses, m.in_reply_to, m.thread_references,
        m.date, m.snippet, m.is_read, m.is_starred, m.has_attachments, m.account_id,
        a.name as account_name, a.email_address as account_email, a.color as account_color
      FROM candidates m JOIN email_accounts a ON m.account_id = a.id
      ) SELECT * FROM matched WHERE copy_rank = 1
      ORDER BY date DESC, id DESC LIMIT $${limitIndex} OFFSET $${limitIndex + 1}
    `;
}
