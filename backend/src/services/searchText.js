export function foldedMatch(expression, index) {
  return `(mailflow_search_fold(${expression}) COLLATE mailflow_search) LIKE mailflow_search_fold($${index}) COLLATE mailflow_search`;
}

export function freeTextTermCondition(likeIdx) {
  return `(${['m.from_name', 'm.from_email', 'm.subject', 'coalesce(m.search_body_text, m.body_text)'].map(column => foldedMatch(column, likeIdx)).join(' OR ')})`;
}

export function searchRowsSQL(conditions, limitIndex) {
  return `
      WITH matched AS (SELECT
        row_number() OVER (PARTITION BY m.account_id, coalesce(nullif(m.message_id, ''), m.id::text)
          ORDER BY (m.folder = 'INBOX') DESC, m.date DESC, m.id) AS copy_rank,
        m.id, m.uid, m.folder, m.message_id, m.subject, m.from_name, m.from_email,
        m.to_addresses, m.cc_addresses, m.in_reply_to, m.thread_references,
        m.date, m.snippet, m.is_read, m.is_starred, m.has_attachments, m.account_id,
        a.name as account_name, a.email_address as account_email, a.color as account_color
      FROM messages m
      JOIN email_accounts a ON m.account_id = a.id
      WHERE m.account_id = ANY($1)
        AND m.is_deleted = false
        AND ${conditions.join('\n        AND ')}
      ) SELECT * FROM matched WHERE copy_rank = 1
      ORDER BY date DESC, id DESC
      LIMIT $${limitIndex} OFFSET $${limitIndex + 1}
    `;
}
