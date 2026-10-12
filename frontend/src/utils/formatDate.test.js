import test from 'node:test';
import process from 'node:process';
import assert from 'node:assert/strict';
import i18n from 'i18next';
import { formatDate, formatDateTime, formatTime, formatTimestamp, formatCalendarDate } from './formatDate.js';

await i18n.init({ lng: 'en', fallbackLng: false });
const at = '2026-10-12T03:31:00Z';

for (const [language, tag] of Object.entries({ en: 'en', ru: 'ru', de: 'de', fr: 'fr', es: 'es', it: 'it', pl: 'pl', cs: 'cs', ko: 'ko', zhCN: 'zh-CN', ptBR: 'pt-BR' })) {
  test(`dates follow app locale ${language}`, async () => {
    await i18n.changeLanguage(language);
    const d = new Date(at);
    assert.equal(formatDateTime(at), new Intl.DateTimeFormat(tag, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d));
    assert.equal(formatTime(at), new Intl.DateTimeFormat(tag, { hour: 'numeric', minute: '2-digit' }).format(d));
    assert.equal(formatTimestamp(at), new Intl.DateTimeFormat(tag, { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(d));
    assert.equal(formatCalendarDate(at), new Intl.DateTimeFormat(tag, { year: 'numeric', month: 'numeric', day: 'numeric' }).format(d));
    const tomorrow = new Date(d);
    tomorrow.setDate(d.getDate() + 1);
    assert.equal(formatDate(at, tomorrow), new Intl.RelativeTimeFormat(tag, { numeric: 'auto' }).format(-1, 'day'));
    assert.equal(formatDate(at, d), formatTime(at));
  });
}

test('relative days use local calendar boundaries across DST', async () => {
  await i18n.changeLanguage('en');
  const original = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    // The previous calendar day is only 23 hours long here.
    assert.equal(formatDate('2026-03-08T00:30:00-05:00', new Date('2026-03-09T00:15:00-04:00')), 'yesterday');
    assert.equal(formatDate('2026-11-01T00:30:00-04:00', new Date('2026-11-02T00:15:00-05:00')), 'yesterday');
    assert.equal(formatDate('2026-10-12T03:31:00Z', new Date('2026-10-12T04:01:00Z')), 'yesterday');
    assert.equal(formatDate('2025-12-31T23:00:00-05:00', new Date('2026-01-01T00:01:00-05:00')), 'yesterday');
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test('old dates include year and invalid values never throw', async () => {
  await i18n.changeLanguage('ru');
  assert.match(formatDate('2025-05-10', new Date('2026-10-12')), /2025/);
  for (const formatter of [formatDate, formatDateTime, formatTime, formatTimestamp, formatCalendarDate]) {
    for (const bad of [null, '', 'not-a-date']) assert.equal(formatter(bad), '');
  }
});
