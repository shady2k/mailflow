import { describe, it, expect } from 'vitest';
import { collectSearchMime } from './searchMime.js';
const parts = [{ part: '1', type: 'text/plain' }, { part: '2', type: 'text/plain' }, { part: '3', type: 'text/html' }];
const decode = value => value.toString();
describe('verified complete MIME search body', () => {
  it('includes tokens in later plain and HTML parts without discarding empty valid parts', () => {
    const result = collectSearchMime(parts, new Map([['1', Buffer.alloc(0)], ['2', Buffer.from('SecondPlainToken')], ['3', Buffer.from('<p>SecondHtmlToken</p>')]]), decode);
    expect(result.text).toContain('SecondPlainToken');
    expect(result.html).toContain('SecondHtmlToken');
  });
  it('refuses a partial response instead of marking it indexed', () => {
    expect(() => collectSearchMime(parts, new Map([['1', Buffer.from('Partial')]]), decode)).toThrow('Incomplete MIME');
  });
});
