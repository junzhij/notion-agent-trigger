import { test } from 'node:test';
import assert from 'node:assert/strict';
import payload from '../fixtures/notion-button-payload.json' with { type: 'json' };
import { handleAdmin, normalisePath, normaliseNotionUserId } from '../src/admin/handler.js';
import { handleRelay } from '../src/relay/handler.js';
import { createMemoryStore } from '../src/lib/store.js';

const RELAY_URL = 'https://relay.example.com/';
const tokens = { 'tok-a': 'user_a', 'tok-b': 'user_b' };

function setup() {
  const store = createMemoryStore();
  const deps = {
    store,
    relayUrl: RELAY_URL,
    verifyToken: async (t) => {
      if (!tokens[t]) throw new Error('bad token');
      return { sub: tokens[t] };
    },
  };
  const api = (method, path, { body, token = 'tok-a', query = {} } = {}) =>
    handleAdmin({ method, path, query, headers: token ? { Authorization: `Bearer ${token}` } : {}, body }, deps);
  return { store, api };
}

test('requires a valid Clerk token', async () => {
  const { api } = setup();
  assert.equal((await api('GET', '/me', { token: null })).status, 401);
  assert.equal((await api('GET', '/me', { token: 'forged' })).status, 401);
  const ok = await api('GET', '/api/me');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { user_id: 'user_a' });
});

test('unknown routes and wrong methods', async () => {
  const { api } = setup();
  assert.equal((await api('GET', '/nope')).status, 404);
  assert.equal((await api('PUT', '/actions')).status, 405);
});

test('create button returns secret once and never exposes the hash', async () => {
  const { api, store } = setup();
  const created = await api('POST', '/buttons', { body: { name: '补全笔记' } });
  assert.equal(created.status, 201);
  const { button, secret } = created.body;
  assert.match(secret, /^nwh_/);
  assert.equal(button.webhook_url, `${RELAY_URL}?b=${button.id}`);
  assert.equal(button.secret_header, 'x-webhook-secret');
  assert.equal(button.secret_hash, undefined);
  assert.equal(button.secret_salt, undefined);
  const stored = await store.get('buttons', button.id);
  assert.notEqual(stored.secret_hash, secret);
  const listed = await api('GET', '/buttons');
  assert.equal(JSON.stringify(listed.body).includes(stored.secret_hash), false);
  assert.equal(JSON.stringify(listed.body).includes(secret), false);
});

test('owners cannot see or modify each other’s rows', async () => {
  const { api } = setup();
  const action = (await api('POST', '/actions', { body: { name: 'A', prompt_template: 'x' } })).body.action;
  const button = (await api('POST', '/buttons', { body: { name: 'B', action_id: action.id } })).body.button;

  assert.equal((await api('GET', '/buttons', { token: 'tok-b' })).body.buttons.length, 0);
  assert.equal((await api('PATCH', `/buttons/${button.id}`, { token: 'tok-b', body: { enabled: false } })).status, 404);
  assert.equal((await api('DELETE', `/actions/${action.id}`, { token: 'tok-b' })).status, 404);
  assert.equal((await api('POST', `/buttons/${button.id}/rotate-secret`, { token: 'tok-b' })).status, 404);
  // user_b cannot attach user_a's action to their own button
  const res = await api('POST', '/buttons', { token: 'tok-b', body: { name: 'C', action_id: action.id } });
  assert.equal(res.status, 400);
});

test('whitelist IDs are validated and normalised', async () => {
  const { api } = setup();
  const b = (await api('POST', '/buttons', { body: { name: 'B' } })).body.button;
  const bad = await api('PATCH', `/buttons/${b.id}`, { body: { allowed_notion_user_ids: ['not-an-id'] } });
  assert.equal(bad.status, 400);
  const good = await api('PATCH', `/buttons/${b.id}`, {
    body: { allowed_notion_user_ids: ['1BFD872B594C81A29A190002E093B3E1', '1bfd872b-594c-81a2-9a19-0002e093b3e1'] },
  });
  assert.equal(good.status, 200);
  assert.deepEqual(good.body.button.allowed_notion_user_ids, ['1bfd872b-594c-81a2-9a19-0002e093b3e1']);
  assert.equal(normaliseNotionUserId('1bfd872b594c81a29a190002e093b3e1'), '1bfd872b-594c-81a2-9a19-0002e093b3e1');
});

test('action in use cannot be deleted', async () => {
  const { api } = setup();
  const action = (await api('POST', '/actions', { body: { name: 'A', prompt_template: 'x' } })).body.action;
  const button = (await api('POST', '/buttons', { body: { name: 'B', action_id: action.id } })).body.button;
  assert.equal((await api('DELETE', `/actions/${action.id}`)).status, 409);
  await api('PATCH', `/buttons/${button.id}`, { body: { action_id: null } });
  assert.equal((await api('DELETE', `/actions/${action.id}`)).status, 200);
});

test('preview renders with the sample payload', async () => {
  const { api } = setup();
  const res = await api('POST', '/preview', { body: { prompt_template: '{{知识点}} / {{缺失}}' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.text, '费马引理 / ');
  assert.deepEqual(res.body.missing, ['缺失']);
  assert.ok(res.body.available_variables.some((v) => v.name === '教材页码'));
  assert.ok(res.body.available_variables.some((v) => v.name === 'page_url' && v.builtin));
});

test('end to end: button created in admin, clicked in Notion, visible in runs', async () => {
  const { api, store } = setup();
  const action = (await api('POST', '/actions', { body: { name: '补全', prompt_template: '补全 {{知识点}}' } })).body.action;
  const { button, secret } = (
    await api('POST', '/buttons', {
      body: { name: '补全笔记', action_id: action.id, allowed_notion_user_ids: [payload.source.user_id] },
    })
  ).body;

  const relay = await handleRelay(
    { query: { b: button.id }, headers: { 'x-webhook-secret': secret }, body: payload },
    { store },
  );
  assert.equal(relay.body.status, 'queued');

  const runs = await api('GET', '/runs');
  assert.equal(runs.body.runs.length, 1);
  assert.equal(runs.body.runs[0].rendered_text, '补全 费马引理');
  assert.equal((await api('GET', '/runs', { token: 'tok-b' })).body.runs.length, 0);
  assert.equal((await api('GET', `/runs/${payload.source.event_id}`, { token: 'tok-b' })).status, 404);

  const listed = (await api('GET', '/buttons')).body.buttons[0];
  assert.equal(listed.bound, true);
  assert.equal(listed.automation_id, payload.source.automation_id);
  const unbound = await api('POST', `/buttons/${button.id}/unbind`);
  assert.equal(unbound.body.button.bound, false);

  // After rotating, the old secret stops working.
  await api('POST', `/buttons/${button.id}/rotate-secret`);
  const again = structuredClone(payload);
  again.source.event_id = 'aaaaaaaa-0000-0000-0000-000000000000';
  const stale = await handleRelay({ query: { b: button.id }, headers: { 'x-webhook-secret': secret }, body: again }, { store });
  assert.equal(stale.status, 401);
});

test('runs pagination', async () => {
  const { api, store } = setup();
  for (let i = 0; i < 5; i++) {
    await store.create('runs', `run${i}`, { owner: 'user_a', button_id: 'b', status: 'queued' });
  }
  const p1 = await api('GET', '/runs', { query: { limit: '2' } });
  assert.deepEqual(p1.body.runs.map((r) => r.id), ['run4', 'run3']);
  const p2 = await api('GET', '/runs', { query: { limit: '2', cursor: p1.body.next_cursor } });
  assert.deepEqual(p2.body.runs.map((r) => r.id), ['run2', 'run1']);
  assert.equal((await api('GET', '/runs', { query: { status: 'bogus' } })).status, 400);
});

test('normalisePath', () => {
  assert.equal(normalisePath('/api/buttons/'), '/buttons');
  assert.equal(normalisePath('/buttons?x=1'), '/buttons');
  assert.equal(normalisePath(''), '/');
});
