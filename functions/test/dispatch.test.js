import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import payload from '../fixtures/notion-button-payload.json' with { type: 'json' };
import { handleRelay } from '../src/relay/handler.js';
import { handleAdmin } from '../src/admin/handler.js';
import { createMemoryStore } from '../src/lib/store.js';
import { newSecretRecord } from '../src/lib/secrets.js';
import { decryptToken, encryptToken, parseEncryptionKey } from '../src/lib/crypto.js';

const KEY = randomBytes(32);
const FIRE_URL = 'https://api.anthropic.com/v1/claude_code/routines/trig_01TEST/fire';
const TOKEN = 'sk-ant-oat01-' + 'x'.repeat(60) + 'ABCD';
const EVENT = payload.source.event_id;

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = responses.shift() ?? { status: 200, body: {} };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: '',
      headers: new Headers(r.headers ?? {}),
      text: async () => JSON.stringify(r.body ?? {}),
    };
  };
  fn.calls = calls;
  return fn;
}

function setup({ credential = {}, action = {}, tokenKey = KEY } = {}) {
  const { secret, secret_salt, secret_hash } = newSecretRecord();
  const store = createMemoryStore({
    credentials: [{ $id: 'cred1', owner: 'user_a', name: 'main', routine_fire_url: FIRE_URL, token_ciphertext: encryptToken(TOKEN, KEY), token_last4: 'ABCD', enabled: true, ...credential }],
    actions: [{ $id: 'act1', owner: 'user_a', name: '补全', prompt_template: '补全「{{知识点}}」', enabled: true, ...action }],
    buttons: [{ $id: 'btn1', owner: 'user_a', name: 'b', action_id: 'act1', allowed_notion_user_ids: [payload.source.user_id], enabled: true, automation_id: payload.source.automation_id, secret_salt, secret_hash }],
  });
  const call = (fetchImpl) =>
    handleRelay(
      { query: { b: 'btn1' }, headers: { 'x-webhook-secret': secret }, body: structuredClone(payload) },
      { store, tokenKey, fetch: fetchImpl },
    );
  return { store, call };
}

test('crypto round trip and key parsing', () => {
  const blob = encryptToken(TOKEN, KEY);
  assert.ok(!blob.includes(TOKEN));
  assert.equal(decryptToken(blob, KEY), TOKEN);
  assert.throws(() => decryptToken(blob, randomBytes(32)));
  assert.equal(parseEncryptionKey(KEY.toString('base64')).length, 32);
  assert.equal(parseEncryptionKey(KEY.toString('hex')).length, 32);
  assert.equal(parseEncryptionKey('short'), null);
  assert.equal(parseEncryptionKey(undefined), null);
});

test('accepted click fires the routine and records the session', async () => {
  const { store, call } = setup();
  const fetchImpl = fakeFetch([{ status: 200, body: { type: 'routine_fire', claude_code_session_id: 's1', claude_code_session_url: 'https://claude.ai/code/s1' } }]);
  const res = await call(fetchImpl);
  assert.equal(res.body.status, 'dispatched');
  assert.equal(fetchImpl.calls.length, 1);
  const { url, init, body } = fetchImpl.calls[0];
  assert.equal(url, FIRE_URL);
  assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(init.headers['anthropic-version'], '2023-06-01');
  assert.equal(init.headers['anthropic-beta'], 'experimental-cc-routine-2026-04-01');
  assert.match(body.text, /page_id：41ac41ba-1344-81ba-a977-faa8f09d07d0/);
  assert.match(body.text, /补全「费马引理」$/);
  const run = await store.get('runs', EVENT);
  assert.equal(run.status, 'dispatched');
  assert.equal(run.session_url, 'https://claude.ai/code/s1');
  assert.equal(run.credential_id, 'cred1');
  assert.ok((await store.get('credentials', 'cred1')).last_used_at);
});

test('retry of the same event does not fire twice', async () => {
  const { call } = setup();
  const fetchImpl = fakeFetch([]);
  await call(fetchImpl);
  const again = await call(fetchImpl);
  assert.equal(again.body.duplicate, true);
  assert.equal(fetchImpl.calls.length, 1);
});

test('429 marks the run failed with Retry-After, still 200 to Notion', async () => {
  const { store, call } = setup();
  const res = await call(fakeFetch([{ status: 429, headers: { 'retry-after': '120' }, body: { error: { message: 'rate limited' } } }]));
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'failed');
  const run = await store.get('runs', EVENT);
  assert.equal(run.status, 'failed');
  assert.match(run.error, /^rate_limited: .*Retry-After 120s/);
  assert.match((await store.get('credentials', 'cred1')).last_error, /rate_limited/);
});

test('network errors mark the run failed', async () => {
  const { store, call } = setup();
  const res = await call(async () => {
    throw new Error('boom');
  });
  assert.equal(res.body.status, 'failed');
  assert.match((await store.get('runs', EVENT)).error, /network error: boom/);
});

test('no encryption key or disabled credential leaves the run queued', async () => {
  let s = setup({ tokenKey: null });
  let fetchImpl = fakeFetch([]);
  assert.equal((await s.call(fetchImpl)).body.status, 'queued');
  assert.match((await s.store.get('runs', EVENT)).error, /TOKEN_ENC_KEY/);
  assert.equal(fetchImpl.calls.length, 0);

  s = setup({ credential: { enabled: false } });
  fetchImpl = fakeFetch([]);
  assert.equal((await s.call(fetchImpl)).body.status, 'queued');
  assert.match((await s.store.get('runs', EVENT)).error, /^no_credential/);
  assert.equal(fetchImpl.calls.length, 0);
});

test("action's credential_id must belong to the button owner", async () => {
  const { store, call } = setup({ action: { credential_id: 'cred2' } });
  await store.create('credentials', 'cred2', { owner: 'user_b', name: 'x', routine_fire_url: FIRE_URL, token_ciphertext: encryptToken(TOKEN, KEY), enabled: true });
  const fetchImpl = fakeFetch([]);
  assert.equal((await call(fetchImpl)).body.status, 'queued');
  assert.equal(fetchImpl.calls.length, 0);
});

// ---------- admin credential routes ----------

function admin(fetchImpl, tokenKey = KEY) {
  const store = createMemoryStore();
  const deps = {
    store,
    tokenKey,
    fetch: fetchImpl,
    verifyToken: async (t) => ({ sub: { a: 'user_a', b: 'user_b' }[t] ?? (() => { throw new Error(); })() }),
  };
  const api = (method, path, { body, token = 'a' } = {}) =>
    handleAdmin({ method, path, query: {}, headers: { Authorization: `Bearer ${token}` }, body }, deps);
  return { store, api };
}

test('credentials: token is encrypted, write-only and validated', async () => {
  const { api, store } = admin();
  assert.equal((await api('POST', '/credentials', { body: { routine_fire_url: 'https://evil.example/fire', token: TOKEN } })).status, 400);
  assert.equal((await api('POST', '/credentials', { body: { routine_fire_url: FIRE_URL, token: 'nope' } })).status, 400);

  const created = await api('POST', '/credentials', { body: { name: '我的 routine', routine_fire_url: FIRE_URL, token: TOKEN } });
  assert.equal(created.status, 201);
  const c = created.body.credential;
  assert.equal(c.token_last4, 'ABCD');
  assert.equal(c.token_ciphertext, undefined);
  assert.ok(!JSON.stringify(created.body).includes(TOKEN));
  const row = await store.get('credentials', c.id);
  assert.equal(decryptToken(row.token_ciphertext, KEY), TOKEN);

  // other users can't see or use it
  assert.equal((await api('GET', '/credentials', { token: 'b' })).body.credentials.length, 0);
  assert.equal((await api('PATCH', `/credentials/${c.id}`, { token: 'b', body: { name: 'x' } })).status, 404);
  assert.equal((await api('POST', '/actions', { token: 'b', body: { name: 'x', credential_id: c.id } })).status, 400);

  // in use → cannot delete
  const action = await api('POST', '/actions', { body: { name: 'x', credential_id: c.id } });
  assert.equal(action.body.action.credential_id, c.id);
  assert.equal((await api('DELETE', `/credentials/${c.id}`)).status, 409);
  await api('PATCH', `/actions/${action.body.action.id}`, { body: { credential_id: null } });
  assert.equal((await api('DELETE', `/credentials/${c.id}`)).status, 200);
});

test('credentials: missing TOKEN_ENC_KEY is reported', async () => {
  const { api } = admin(undefined, null);
  const res = await api('POST', '/credentials', { body: { routine_fire_url: FIRE_URL, token: TOKEN } });
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'server_not_configured');
});

test('credentials: test fires a ping', async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: { claude_code_session_url: 'https://claude.ai/code/s9' } }, { status: 401, body: { error: { message: 'bad token' } } }]);
  const { api } = admin(fetchImpl);
  const { credential } = (await api('POST', '/credentials', { body: { routine_fire_url: FIRE_URL, token: TOKEN } })).body;
  const ok = await api('POST', `/credentials/${credential.id}/test`, { body: {} });
  assert.deepEqual(ok.body, { ok: true, session_url: 'https://claude.ai/code/s9', session_id: null });
  assert.match(fetchImpl.calls[0].body.text, /pong/);
  const bad = await api('POST', `/credentials/${credential.id}/test`, { body: {} });
  assert.equal(bad.body.ok, false);
  assert.match(bad.body.error, /^token_rejected/);
  const list = await api('GET', '/credentials');
  assert.match(list.body.credentials[0].last_error, /token_rejected/);
});
