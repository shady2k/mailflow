import { randomUUID } from 'node:crypto';
export const MASKED_HEADER_VALUE = '••••••••';
const NAME = /^[!#$%&'*+.^_`|~0-9a-z-]{1,128}$/i;
const RESERVED = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'keep-alive', 'te', 'trailer', 'authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'content-type', 'accept', 'x-api-key', 'api-key', 'x-auth-token']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class AiHeaderError extends Error {
  constructor(message) { super(message); this.name = 'AiHeaderError'; this.status = 400; }
}
export function validateAiHeaders(entries) {
  if (!Array.isArray(entries) || entries.length > 20) throw new AiHeaderError('AI headers must be an array with at most 20 entries');
  const seen = new Set(); let bytes = 0;
  return entries.map(entry => {
    if (!entry || typeof entry.name !== 'string' || !NAME.test(entry.name)) throw new AiHeaderError('Invalid AI header name');
    const name = entry.name.toLowerCase();
    if (seen.has(name)) throw new AiHeaderError('Duplicate AI header names are not allowed');
    if (RESERVED.has(name) || name.startsWith('proxy-') || name.startsWith('sec-')) throw new AiHeaderError('Reserved AI header name');
    seen.add(name);
    const value = entry.value;
    if (typeof value !== 'string' || value.length > 2048 || (value !== MASKED_HEADER_VALUE && /[^\x20-\x7e]/.test(value))) throw new AiHeaderError('AI header values must be printable ASCII and at most 2048 characters');
    bytes += name.length + value.length;
    if (bytes > 16384) throw new AiHeaderError('AI headers exceed the 16 KiB total limit');
    return { name, value };
  });
}
export function createAiTaskContext(sessionId = randomUUID()) {
  if (!UUID.test(sessionId)) throw new AiHeaderError('Invalid AI task session ID');
  return Object.freeze({ sessionId });
}
export function resolveAiHeaders(entries, context) {
  const sessionId = createAiTaskContext(context?.sessionId).sessionId;
  return validateAiHeaders(entries.map(entry => ({ ...entry, value: entry.value.replaceAll('{session_id}', sessionId) })));
}
