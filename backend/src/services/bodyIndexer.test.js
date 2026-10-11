import { describe, it, expect, vi } from 'vitest';
import { BodyIndexer, searchableBody, retryDelay, bodyIndexStatus } from './bodyIndexer.js';

const row = { id: 'm', uid: 7, folder: 'Archive', message_id: null, body_text: null, body_html: null, body_index_attempts: 0, account: { id: 'a' } };

describe('full body materialization', () => {
  it('keeps text beyond snippet/vector caps and safely extracts all HTML text', () => {
    const html = '<style>HiddenStyle</style><script>HiddenScript</script><p>' + 'x'.repeat(650000) + '</p><p>Спасибо &amp; ENbody <img src="https://outside.invalid/pixel"></p>';
    const text = searchableBody({ html, text: 'PlainBody' });
    expect(text).toContain('Спасибо & ENbody');
    expect(text).toContain('PlainBody');
    expect(text).not.toContain('HiddenScript');
    expect(text).not.toContain('outside.invalid');
  });
  it('indexes cached HTML without fetching again, including an empty valid body', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const fetchBody = vi.fn();
    const worker = new BodyIndexer({ query, fetchBody });
    await worker.index({ ...row, body_html: '<p>Unopened</p>' });
    expect(fetchBody).not.toHaveBeenCalled();
    expect(query.mock.calls[0][1][0]).toBe('Unopened');
    await worker.index({ ...row, body_text: '' });
    expect(fetchBody).not.toHaveBeenCalled();
  });
  it('persists errors and retry dates instead of reporting unavailable messages complete', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const worker = new BodyIndexer({ query, fetchBody: vi.fn().mockResolvedValue({ html: null, text: null }) });
    await worker.index(row);
    expect(query.mock.calls[0][0]).toContain('body_index_retry_at');
    expect(query.mock.calls[0][1][0]).toBe(1);
    expect(query.mock.calls[0][1][1]).toContain('unavailable');
    expect(retryDelay(100)).toBe(3600000);
  });
  it('respects provider cooldown and guards a result against moved/changed message identity', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const fetchBody = vi.fn();
    await new BodyIndexer({ query, fetchBody, canFetch: () => false }).index(row);
    expect(fetchBody).not.toHaveBeenCalled();
    expect(query.mock.calls[0][0]).toContain('message_id IS NOT DISTINCT');
  });
  it('bounds concurrent claims, skips leased/completed rows and cannot overlap ticks', async () => {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    const query = vi.fn().mockResolvedValueOnce({ rows: [row, { ...row, id: 'other', account: { id: 'b' } }] }).mockResolvedValue({ rows: [] });
    const fetchBody = vi.fn().mockImplementation(() => promise);
    const worker = new BodyIndexer({ query, fetchBody, concurrency: 2 });
    const first = worker.tick();
    await Promise.resolve();
    await worker.tick();
    expect(fetchBody).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][1]).toEqual([2]);
    expect(query.mock.calls[0][0]).toContain('SKIP LOCKED');
    expect(query.mock.calls[0][0]).toContain('body_indexed_at IS NULL');
    expect(query.mock.calls[0][0]).toContain('body_index_lease_until <= now()');
    release({ text: 'OnlyInBody', found: true });
    await first;
    expect(query).toHaveBeenCalledTimes(3);
  });
  it('reports persisted completion/errors on each fresh status read', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ account_id: 'a', headers_loaded: 2, bodies_searchable: 1, pending: 1, failed: 1 }] });
    expect((await bodyIndexStatus(query, 'u'))[0].complete).toBe(false);
    expect((await bodyIndexStatus(query, 'u'))[0].failed).toBe(1);
  });
});
