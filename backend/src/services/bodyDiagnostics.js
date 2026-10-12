import { randomUUID } from 'node:crypto';

export function bodyDiagnostics(res, enabled = process.env.MAILFLOW_BODY_DIAGNOSTICS === 'true', log = console.info) {
  if (!enabled) return () => {};
  const requestId = randomUUID();
  const started = Date.now();
  const trace = (stage, metrics = {}) => {
    const safe = {};
    for (const key of ['waitMs', 'durationMs', 'status', 'complete', 'cached']) {
      if (typeof metrics[key] === 'number' || typeof metrics[key] === 'boolean') safe[key] = metrics[key];
    }
    log(JSON.stringify({ event: 'mailflow_body', requestId, stage, ...safe }));
  };
  res.setHeader('X-MailFlow-Body-Trace', requestId);
  res.once('finish', () => trace('api_finish', { status: res.statusCode, durationMs: Date.now() - started }));
  trace('api_start');
  return trace;
}
