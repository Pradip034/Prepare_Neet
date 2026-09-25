import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from '../src/server.js';
import { normalizeIdentifier } from '../src/accounts.js';

async function start(dbPath = ':memory:', extra = {}) {
  const server = createServer({ dbPath, apiKey: '', ...extra });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
const close = server => new Promise(resolve => server.close(resolve));
async function call(url, path, { cookie, body, origin } = {}) {
  return fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: {
    ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}),
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
  }, body: body === undefined ? undefined : JSON.stringify(body) });
}
const loginCookie = response => response.headers.get('set-cookie').split(';')[0];

test('email and mobile format validation and normalization', () => {
  assert.equal(normalizeIdentifier('Student@Example.com').identifier, 'student@example.com');
  assert.equal(normalizeIdentifier('98765 43210').identifier, '+919876543210');
  assert.equal(normalizeIdentifier('+91 98765-43210').identifier, '+919876543210');
  assert.equal(normalizeIdentifier('+44 7700 900123').kind, 'mobile');
  for (const invalid of ['', 'abc', 'x@y', 'x@@example.com', 'x..y@example.com', '1234567890', '+911234567890', '+0123456789', '<script>@example.com']) {
    assert.throws(() => normalizeIdentifier(invalid), { status: 400 });
  }
});

test('password login, secure sessions, logout, and cross-origin rejection', async () => {
  const { server, url } = await start(':memory:', { secureCookies: true });
  try {
    const body = { identifier: 'student@example.com', password: 'a-long-test-password' };
    const registered = await call(url, '/api/v1/auth/register', { body });
    assert.equal(registered.status, 201);
    assert.match(registered.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.match(registered.headers.get('set-cookie'), /Secure/);
    const user = (await registered.json()).user;
    assert.equal(user.verified, false);
    assert.equal('password_hash' in user, false);
    const cookie = loginCookie(registered);
    assert.equal((await (await call(url, '/api/v1/auth/me', { cookie })).json()).user.id, user.id);
    assert.equal((await call(url, '/api/v1/auth/login', { body: { ...body, password: 'wrong-password' } })).status, 401);
    assert.equal((await call(url, '/api/v1/auth/login', { body: { ...body, identifier: 'missing@example.com' } })).status, 401);
    assert.equal((await call(url, '/api/v1/auth/register', { body })).status, 409);
    assert.equal((await call(url, '/api/v1/auth/register', { body: { identifier: 'new@example.com', password: 'short' } })).status, 400);
    assert.equal((await call(url, '/api/v1/auth/logout', { cookie, origin: 'https://evil.example', body: {} })).status, 403);
    await call(url, '/api/v1/auth/logout', { cookie, body: {} });
    assert.equal((await (await call(url, '/api/v1/auth/me', { cookie })).json()).user, null);
    assert.equal((await call(url, '/api/v1/auth/login', { body })).status, 200);
  } finally { await close(server); }
});

test('saved practices are owner-only, server-scored, idempotent, and survive restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'neet-accounts-test-'));
  const dbPath = join(dir, 'test.sqlite');
  let { server, url } = await start(dbPath);
  try {
    const identity = { identifier: '9876543210', password: 'test-password-123' };
    const registration = await call(url, '/api/v1/auth/register', { body: identity });
    const cookie = loginCookie(registration);
    const other = loginCookie(await call(url, '/api/v1/auth/register', { body: { identifier: 'other@example.com', password: 'other-password-123' } }));
    assert.equal((await call(url, '/api/v1/practices')).status, 401);
    assert.equal((await call(url, '/api/v1/practices', { cookie, body: { questionNumbers: [198] } })).status, 400);
    const created = await call(url, '/api/v1/practices', { cookie, body: { questionNumbers: [1, 2, 3, 4] } });
    const id = (await created.json()).data.id;
    assert.equal(created.status, 201);
    for (const path of [`/api/v1/practices/${id}`, `/api/v1/practices/${id}/report.pdf`]) {
      assert.equal((await call(url, path, { cookie: other })).status, 404);
    }
    const answer = { number: 1, selectedOption: 'A', reason: 'answered', points: 999 };
    const first = await call(url, `/api/v1/practices/${id}/answers`, { cookie, body: answer });
    assert.equal((await first.json()).results[0].points, 4);
    assert.equal((await call(url, `/api/v1/practices/${id}/answers`, { cookie, body: answer })).status, 200);
    assert.equal((await call(url, `/api/v1/practices/${id}/answers`, { cookie, body: { ...answer, selectedOption: 'B' } })).status, 409);
    assert.equal((await call(url, `/api/v1/practices/${id}/answers`, { cookie, body: { ...answer, number: 5 } })).status, 400);
    assert.equal((await call(url, `/api/v1/practices/${id}/answers`, { cookie, body: { number: 2, selectedOption: 'B', reason: 'timeout' } })).status, 400);
    await call(url, `/api/v1/practices/${id}/answers`, { cookie, body: { number: 2, selectedOption: 'B', reason: 'answered' } });
    await call(url, `/api/v1/practices/${id}/answers`, { cookie, body: { number: 3, selectedOption: null, reason: 'timeout' } });
    const before = (await (await call(url, `/api/v1/practices/${id}`, { cookie })).json()).data;
    assert.equal(before.report.score, 3);
    assert.equal(before.report.total, 3);
    assert.equal(before.status, 'in_progress');
    const finished = (await (await call(url, `/api/v1/practices/${id}/finish`, { cookie, body: {} })).json()).data;
    assert.equal(finished.status, 'completed');
    assert.equal(finished.report.maxScore, 12);
    assert.equal((await call(url, `/api/v1/practices/${id}/answers`, { cookie, body: { number: 4, selectedOption: 'B', reason: 'answered' } })).status, 409);
    assert.equal((await call(url, `/api/v1/practices/${id}/finish`, { cookie: other, body: {} })).status, 404);
    await close(server);
    const restarted = await start(dbPath); server = restarted.server; url = restarted.url;
    const saved = (await (await call(url, '/api/v1/practices', { cookie })).json()).data;
    assert.equal(saved.length, 1);
    assert.equal(saved[0].score, 3);
    assert.equal((await (await call(url, '/api/v1/practices', { cookie: other })).json()).data.length, 0);
    assert.equal((await call(url, '/api/v1/auth/login', { body: { ...identity, identifier: '+91 98765 43210' } })).status, 200);
    const pdf = await call(url, `/api/v1/practices/${id}/report.pdf`, { cookie });
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.match(await pdf.text(), /Score: 3 \/ 12/);
    const db = new DatabaseSync(dbPath);
    const stored = db.prepare('SELECT password_hash,salt FROM users LIMIT 1').get();
    assert.notEqual(stored.password_hash, identity.password);
    assert.equal(stored.password_hash.length, 128);
    assert.ok(stored.salt);
    db.close();
  } finally { await close(server); }
});

test('login attempts are limited', async () => {
  const { server, url } = await start();
  try {
    let response;
    for (let i = 0; i < 26; i++) response = await call(url, '/api/v1/auth/login', { body: { identifier: 'student@example.com', password: 'incorrect-password' } });
    assert.equal(response.status, 429);
  } finally { await close(server); }
});
