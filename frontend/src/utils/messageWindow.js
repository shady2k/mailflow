// Refresh the whole loaded window atomically; the server caps each page at 500.
export async function fetchMessageWindow(fetchPage, params, size) {
  const messages = [];
  const seen = new Set();
  let total = 0, offset = 0;
  while (messages.length < size) {
    const limit = Math.min(500, size - messages.length);
    const data = await fetchPage({ ...params, offset, limit });
    total = data.total;
    for (const message of data.messages) {
      if (seen.has(message.id)) continue;
      seen.add(message.id); messages.push(message);
    }
    offset += data.messages.length;
    if (data.messages.length < limit || offset >= total) break;
  }
  return { messages, total };
}
