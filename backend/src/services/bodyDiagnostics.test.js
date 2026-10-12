import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { bodyDiagnostics } from './bodyDiagnostics.js';

describe('opt-in body diagnostics', () => {
  it('stays silent by default and never emits arbitrary message or credential fields', () => {
    const res = Object.assign(new EventEmitter(), { setHeader: vi.fn(), statusCode: 200 });
    const log = vi.fn();
    bodyDiagnostics(res, false, log)('cache_hit');
    expect(log).not.toHaveBeenCalled();
    expect(res.setHeader).not.toHaveBeenCalled();
    const trace = bodyDiagnostics(res, true, log);
    trace('cache_hit', { cached: true, waitMs: 2, email: 'private@example.invalid', subject: 'Private', token: 'secret', body: 'private' });
    res.emit('finish');
    const rows = log.mock.calls.map(([value]) => JSON.parse(value));
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map(row => row.requestId)).size).toBe(1);
    expect(rows[1].cached).toBe(true);
    expect(rows[2].status).toBe(200);
    expect(JSON.stringify(rows)).not.toMatch(/private|secret|subject|token|email/i);
  });
});
