// Fill only the requested visible window, advancing over raw rows hidden by optimistic guards.
export async function fetchMessageWindow(fetchPage, params, size, filter = rows => rows) {
  const messages = [], seen = new Set(), rawSeen = new Set();
  let total = 0, offset = Number(params.offset) || 0, hasMore = false;
  const pageOffset = offset;
  while (messages.length < size) {
    const limit = Math.min(500, size - messages.length);
    const data = await fetchPage({ ...params, offset, limit });
    total = data.total;
    const unique = data.messages.filter(row => { if (rawSeen.has(row.id)) return false; rawSeen.add(row.id); return true; });
    if (data.messages.length && !unique.length) throw new Error('Repeated message page');
    for (const message of filter(unique)) {
      if (seen.has(message.id)) continue;
      seen.add(message.id); messages.push(message);
    }
    const next = Number.isFinite(data.nextOffset) ? data.nextOffset : offset + data.messages.length;
    hasMore = typeof data.hasMore === 'boolean' ? data.hasMore : data.messages.length >= limit && next < total;
    if (!data.messages.length || next <= offset) { hasMore = false; break; }
    offset = next;
    if (!hasMore) break;
  }
  return { messages, total, nextOffset: offset, hasMore, pageOffset };
}

export async function fetchMessagePage(fetchPage, params, size, filter) {
  const page = await fetchMessageWindow(fetchPage, params, size, filter);
  if (page.total > 0 && page.pageOffset >= page.total) {
    const offset = Math.floor((page.total - 1) / size) * size;
    return fetchMessageWindow(fetchPage, { ...params, offset }, size, filter);
  }
  return page;
}
