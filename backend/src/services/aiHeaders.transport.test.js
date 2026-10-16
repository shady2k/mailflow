import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import { once } from 'node:events';
const state = vi.hoisted(() => ({ config: null, writes: 0 }));
vi.mock('./db.js', () => ({ query: vi.fn(async sql => {
  if (sql.startsWith('SELECT value')) return { rows: state.config ? [{ value: JSON.stringify(state.config) }] : [] };
  state.writes++; return { rows: [] };
}) }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: async () => ({ allowPrivateHosts: true }) }));
vi.mock('./hostValidation.js', () => ({ validateHost: async () => null }));
import { encrypt } from './encryption.js';
import { completeText, streamChat, testAiProvider, getAdminAiConfig } from './aiProvider.js';
import { summarizeMessage } from './summarize.js';
import { aiClassifyMessage } from './categorizer.js';
const records = []; let server, redirected, base, redirect = false, redirectedRequests = 0;
beforeAll(async () => {
  vi.stubEnv('ENCRYPTION_KEY', '1234567890abcdef'.repeat(4));
  redirected = http.createServer((_req, res) => { redirectedRequests++; res.end('unexpected'); });
  redirected.listen(0, '127.0.0.1'); await once(redirected, 'listening');
  server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); records.push({ headers: req.headers, body });
    if (redirect) { res.writeHead(302, { Location: `http://127.0.0.1:${redirected.address().port}/unexpected` }); res.end(); return; }
    if (body.stream) { res.setHeader('Content-Type', 'text/event-stream'); res.end('data: {"choices":[{"delta":{"content":"synthetic text"}}]}\n\ndata: [DONE]\n\n'); return; }
    const content = body.messages[0].content.startsWith('Classify') ? 'primary' : 'synthetic summary';
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}/v1`;
  state.config = { provider: 'api-key', enabled: true, apiKeyConfig: { baseUrl: base, model: 'synthetic-model', apiKey: null, headers: [{ name: 'x-opencode-session', value: encrypt('{session_id}') }, { name: 'x-static', value: encrypt('public-synthetic-header') }] } };
});
afterAll(async () => {
  for (const s of [server, redirected]) { s.closeAllConnections(); await new Promise(resolve => s.close(resolve)); }
  vi.unstubAllEnvs();
});
describe('shared AI transport against synthetic HTTP server', () => {
  it('passes configured headers for compose/actions streaming, summary and classification with distinct task IDs', async () => {
    for (const task of ['compose', 'action']) { let text = ''; for await (const chunk of streamChat([{ role: 'user', content: 'synthetic '+task }])) text += chunk; expect(text).toBe('synthetic text'); }
    expect(await summarizeMessage({ subject: 'Synthetic', content: 'Synthetic body' })).toBe('synthetic summary');
    expect(await aiClassifyMessage('Synthetic', 'sender@lab.test', 'Synthetic preview')).toBe('primary');
    expect(records).toHaveLength(4);
    expect(new Set(records.map(r => r.headers['x-opencode-session'])).size).toBe(4);
    for (const row of records) { expect(row.headers['x-static']).toBe('public-synthetic-header'); expect(row.headers['x-opencode-session']).toMatch(/^[0-9a-f-]{36}$/); }
  });
  it('keeps a caller-supplied durable task context across summary retries', async () => {
    const taskContext = { sessionId: '12345678-1234-4234-8234-123456789abc' };
    await summarizeMessage({ subject: 'Synthetic pending job', taskContext });
    await summarizeMessage({ subject: 'Synthetic pending job retry', taskContext });
    expect(records.at(-1).headers['x-opencode-session']).toBe(taskContext.sessionId);
    expect(records.at(-2).headers['x-opencode-session']).toBe(taskContext.sessionId);
  });
  it('tests unsaved edited headers without persisting or revealing values', async () => {
    const snapshot = JSON.stringify(state.config);
    await testAiProvider({ ...state.config, apiKeyConfig: { baseUrl: base, model: 'edited-model', headers: [{ name: 'x-opencode-session', value: '{session_id}' }, { name: 'x-static', value: 'public-unsaved-header' }] } });
    expect(records.at(-1).headers['x-static']).toBe('public-unsaved-header');
    expect(records.at(-1).body.model).toBe('edited-model'); expect(JSON.stringify(state.config)).toBe(snapshot); expect(state.writes).toBe(0);
    const publicConfig = await getAdminAiConfig(); expect(publicConfig.apiKeyConfig.headers.every(h => h.value === '••••••••')).toBe(true);
    expect(JSON.stringify(publicConfig)).not.toContain('public-synthetic-header');
  });
  it('does not forward custom headers to another redirect origin', async () => {
    redirect = true;
    await expect(completeText([{ role: 'user', content: 'synthetic redirect' }])).rejects.toThrow('AI provider redirected the request (302)');
    expect(redirectedRequests).toBe(0); redirect = false;
  });
});
