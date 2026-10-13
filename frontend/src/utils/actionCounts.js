export function inboxUnreadDelta(message, count = 1) {
  return message?.folder === 'INBOX' ? count : 0;
}

export function inboxUnreadCounts(messages) {
  const counts = new Map();
  const seen = new Set();
  for (const message of messages || []) {
    if (!message?.id || !message.account_id || seen.has(message.id) || message.is_read || message.folder !== 'INBOX') continue;
    seen.add(message.id);
    counts.set(message.account_id, (counts.get(message.account_id) || 0) + 1);
  }
  return counts;
}

export function adjustInboxTransition(message, destination, incrementUnread, decrementUnread, reverse = false) {
  if (message.is_read || message.folder === destination) return;
  const delta = Number(destination === 'INBOX') - Number(message.folder === 'INBOX');
  const effective = reverse ? -delta : delta;
  if (effective > 0) incrementUnread(message.account_id, effective);
  if (effective < 0) decrementUnread(message.account_id, -effective);
}

export function folderCountChanges(messages, { destination = null, read } = {}) {
  const changes = new Map();
  const seen = new Set();
  const add = (message, folder, total, unread) => {
    if (!folder || !message.account_id) return;
    const key = JSON.stringify([message.account_id, folder]);
    const previous = changes.get(key) || { accountId: message.account_id, folder, total: 0, unread: 0 };
    changes.set(key, { ...previous, total: previous.total + total, unread: previous.unread + unread });
  };
  for (const message of messages || []) {
    if (!message?.id || seen.has(message.id)) continue;
    seen.add(message.id);
    if (read !== undefined) {
      add(message, message.folder, 0, Number(!read) - Number(!message.is_read));
    } else if (message.folder !== destination) {
      add(message, message.folder, -1, message.is_read ? 0 : -1);
      add(message, destination, 1, message.is_read ? 0 : 1);
    }
  }
  return [...changes.values()].filter(change => change.total || change.unread);
}
