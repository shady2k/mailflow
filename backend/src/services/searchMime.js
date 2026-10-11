// A missing part is retryable; a present zero-length part is a complete body.
export function collectSearchMime(parts, payloads, decode) {
  const plain = [], html = [];
  for (const part of parts) {
    if (!payloads.has(part.part) || payloads.get(part.part) == null) throw new Error('Incomplete MIME body; retry pending');
    const decoded = decode(payloads.get(part.part), part.encoding, part.charset);
    (part.type === 'text/html' ? html : plain).push(decoded);
  }
  return { text: plain.length ? plain.join('\n') : null, html: html.length ? html.join('\n') : null };
}
