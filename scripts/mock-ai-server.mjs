// Synthetic localhost-only provider for the isolated Docker lab. No real key.
import http from 'node:http';
if (process.env.APP_URL !== 'http://localhost:18090' || process.env.DB_PASSWORD !== 'public-synthetic-ai-database') throw new Error('Fresh synthetic lab required');
const records = [];
const server = http.createServer(async (req, res) => {
  if (req.url === '/stats') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(records)); return; }
  if (req.url === '/shutdown') { res.end('ok'); server.close(); return; }
  if (req.url !== '/v1/chat/completions' || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
  if (req.headers.authorization && req.headers.authorization !== 'Bearer public-synthetic-ai-key') { res.writeHead(400); res.end(); return; }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  if (!['synthetic-model', 'edited-synthetic-model'].includes(body.model)) { res.writeHead(400); res.end(); return; }
  if (!/^[0-9a-f-]{36}$/.test(req.headers['x-opencode-session'] || '')) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Missing synthetic x-opencode-session' })); return; }
  records.push({ sessionId: req.headers['x-opencode-session'], staticValue: req.headers['x-static'], model: body.model });
  if (body.stream) { res.setHeader('Content-Type', 'text/event-stream'); res.end('data: {"choices":[{"delta":{"content":"Synthetic response"}}]}\n\ndata: [DONE]\n\n'); return; }
  const content = body.messages.some(m => m.content.startsWith('Classify')) ? 'primary' : 'Synthetic summary';
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content } }] }));
});
server.listen(3801, '127.0.0.1', () => console.log('Synthetic AI server listening on internal loopback'));
const timer = setTimeout(() => server.close(), 600000); timer.unref();
server.on('close', () => clearTimeout(timer));
