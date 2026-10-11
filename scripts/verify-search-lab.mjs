import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire('/app/package.json');
const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const { Pool } = require('pg');
assert.equal(process.env.DB_HOST, 'postgres');
assert.equal(process.env.APP_URL, 'http://localhost:18089');
let cookies = '';
async function api(path, data) {
  const response = await fetch('http://localhost:3000/api/' + path, {
    method: data ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'MailFlow', Origin: 'http://localhost:18089', Cookie: cookies },
    body: data ? JSON.stringify(data) : undefined,
  });
  if (response.headers.getSetCookie().length) cookies = response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result)); return result;
}
await api('auth/login', { username: 'demo', password: 'DemoMail123!' });
const accounts = await api('accounts');
assert.ok(accounts.every(a => a.email_address.endsWith('@lab.test')));
const bob = accounts.find(a => a.email_address === 'bob@lab.test');
const alice = accounts.find(a => a.email_address === 'alice@lab.test');
const stamp = String(Date.now());
const plainToken = 'UnopenedPlain' + stamp;
const htmlToken = 'UnopenedHtml' + stamp;
const archivedToken = 'ArchiveOnly' + stamp;
const multipartToken = 'SecondMimePart' + stamp;
const smtp = nodemailer.createTransport({ host: 'test-mail', port: 3025, ignoreTLS: true, auth: { user: 'alice', pass: 'DemoMail123!' } });
const prefix = 'ordinary preamble '.repeat(50);
await smtp.sendMail({ from: 'АЛЕКСЕЙ <alice@lab.test>', to: 'bob@lab.test', subject: 'Спасибо Plain ' + stamp, text: prefix + plainToken + ' СИНТЕТИКА' });
await smtp.sendMail({ from: 'ИВАН <bob@lab.test>', to: 'alice@lab.test', subject: 'HELLO HTML ' + stamp, html: `<style>HiddenStyle</style><p>${prefix}</p><p>${htmlToken} РусскийТекст</p><img src="https://outside.invalid/pixel">` });
await smtp.sendMail({ envelope: { from: 'alice@lab.test', to: 'bob@lab.test' }, raw: [
  'From: alice@lab.test', 'To: bob@lab.test', 'Subject: Multipart ' + stamp,
  'Message-ID: <multipart-' + stamp + '@lab.test>', 'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="search-boundary"', '',
  '--search-boundary', 'Content-Type: text/plain; charset=utf-8', '', prefix,
  '--search-boundary', 'Content-Type: text/plain; charset=utf-8', '', multipartToken,
  '--search-boundary--', '',
].join('\r\n') });
const imap = new ImapFlow({ host: 'test-mail', port: 3143, secure: false, logger: false, auth: { user: 'bob', pass: 'DemoMail123!' } });
await imap.connect();
try { await imap.mailboxCreate('Archive'); } catch { /* may already exist */ }
const composer = nodemailer.createTransport({ streamTransport: true, buffer: true });
const raw = await composer.sendMail({ from: 'alice@lab.test', to: 'bob@lab.test', subject: 'Archived ' + stamp, text: prefix + archivedToken + ' АРХИВ', messageId: `<archive-${stamp}@lab.test>` });
await imap.append('Archive', raw.message);
await imap.logout();
await api('mail/sync-folders', {});
await api('mail/sync', {});
await api('mail/sync-folder', { accountId: bob.id, folder: 'Archive' });
const db = new Pool({ host: 'postgres', database: 'mailflow', user: 'mailflow', password: process.env.DB_PASSWORD });
const deadline = Date.now() + 45000;
let statuses, matches;
while (Date.now() < deadline) {
  statuses = await api('search/index-status');
  matches = await Promise.all([plainToken, htmlToken, archivedToken, multipartToken].map(t => api('search?q=' + t.toLowerCase())));
  if (matches.every(r => r.messages.length === 1)) {
    const indexed = await db.query('SELECT count(*)::int AS n FROM messages WHERE id=ANY($1::uuid[]) AND body_indexed_at IS NOT NULL', [matches.map(r => r.messages[0].id)]);
    if (indexed.rows[0].n === 4) break;
  }
  await new Promise(r => setTimeout(r, 1000));
}
assert.ok(matches.every(r => r.messages.length === 1));
const fresh = (await db.query('SELECT is_read, body_text, body_html, search_body_text, body_indexed_at FROM messages WHERE id=ANY($1::uuid[])', [matches.map(r => r.messages[0].id)])).rows;
assert.equal(fresh.length, 4);
assert.ok(fresh.every(m => !m.is_read && m.body_indexed_at && m.search_body_text));
assert.equal((await api('search?q=' + plainToken + '&accountId=' + alice.id)).messages.length, 0);
assert.equal((await api('search?q=' + archivedToken + '&folder=INBOX')).messages.length, 0);
assert.equal((await api('search?q=' + archivedToken + '&folder=Archive')).messages.length, 1);
assert.ok((await api('search?q=' + encodeURIComponent('subject:спасибо from:алексей'))).messages.length);
assert.ok((await api('search?q=' + encodeURIComponent('русскийтекст'))).messages.some(m => m.account_id === alice.id));
console.log(JSON.stringify({ version: await api('version'), tokens: [plainToken, htmlToken, archivedToken, multipartToken], unopenedBodies: 4, plainHtmlArchive: 'passed', ruEnCase: 'passed', folderAccountFilters: 'passed', status: statuses }, null, 2));
await db.end();
