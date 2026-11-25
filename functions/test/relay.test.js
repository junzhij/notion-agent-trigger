import { test } from 'node:test';
import assert from 'node:assert/strict';
import payload from '../fixtures/notion-button-payload.json' with { type: 'json' };
import { handleRelay } from '../src/relay/handler.js';
import { createMemoryStore } from '../src/lib/store.js';
import { newSecretRecord, verifySecret, hashSecret } from '../src/lib/secrets.js';

const CLICKER = payload.source.user_id;
const AUTOMATION = payload.source.automation_id;
const EVENT = payload.source.event_id;

function setup({ button = {}, action = {} } = {}) {
  const { secret, secret_salt, secret_hash } = newSecretRecord();
  const store = createMemoryStore({
    actions: [{ $id: 'act1', owner: 'user_a', name: '补全', prompt_template: '补全「{{知识点}}」 {{page_url}}', enabled: true, ...action }],
    buttons: [
      {
        $id: 'btn1',
        owner: 'user_a',
        name: '补全笔记',
        action_id: 'act1',
        allowed_notion_user_ids: [CLICKER],
        enabled: true,
        automation_id: null,
        secret_salt,
        secret_hash,
        ...button,
      },
    ],
  });
  const logs = [];
  const call = (overrides = {}) =>
    handleRelay(
      {
        query: { b: 'btn1' },
        headers: { 'X-Webhook-Secret': secret },
        body: structuredClone(payload),
        ...overrides,
      },
      { store, log: (m) => logs.push(m) },
    );
  return { store, secret, call, logs };
}

test('happy path: binds automation, queues run with rendered text', async () => {
  const { store, call } = setup();
  const res = await call();
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'queued');
  const run = await store.get('runs', EVENT);
  assert.equal(run.status, 'queued');
  assert.equal(run.owner, 'user_a');
  assert.equal(run.button_id, 'btn1');
  assert.equal(run.page_title, '费马引理');
  assert.equal(run.rendered_text, '[Notion 按钮触发]\n页面标题：费马引理\npage_id：41ac41ba-1344-81ba-a977-faa8f09d07d0\npage_url：https://app.notion.com/p/41ac41ba134481baa977faa8f09d07d0\n\n' + '补全「费马引理」 https://app.notion.com/p/41ac41ba134481baa977faa8f09d07d0');
  assert.match(run.error, /^no_credential/);
  assert.equal((await store.get('buttons', 'btn1')).automation_id, AUTOMATION);
});

test('retries with the same event_id are deduplicated', async () => {
  const { store, call } = setup();
  await call();
  const retry = structuredClone(payload);
  retry.source.attempt = 2;
  const res = await call({ body: retry });
  assert.equal(res.status, 200);
  assert.equal(res.body.duplicate, true);
  assert.equal(store.tables.runs.size, 1);
  assert.equal((await store.get('runs', EVENT)).attempt, 1);
});

test('wrong or missing secret returns 401 and records nothing', async () => {
  const { store, call } = setup();
  assert.equal((await call({ headers: { 'x-webhook-secret': 'nope' } })).status, 401);
  assert.equal((await call({ headers: {} })).status, 401);
  assert.equal(store.tables.runs.size, 0);
  assert.equal((await store.get('buttons', 'btn1')).automation_id, null);
});

test('bad secret status is configurable', async () => {
  const { store, secret } = setup();
  const res = await handleRelay(
    { query: { b: 'btn1' }, headers: { 'x-webhook-secret': secret + 'x' }, body: payload },
    { store, badSecretStatus: 200 },
  );
  assert.equal(res.status, 200);
});

test('unknown or malformed button id returns 200 without a run', async () => {
  const { store, call } = setup();
  assert.equal((await call({ query: { b: 'missing' } })).body.reason, 'unknown_button');
  assert.equal((await call({ query: {} })).body.reason, 'unknown_button');
  assert.equal((await call({ query: { b: '../etc' } })).body.reason, 'unknown_button');
  assert.equal(store.tables.runs.size, 0);
});

test('automation mismatch is rejected with 200 and recorded', async () => {
  const { store, call } = setup({ button: { automation_id: 'other-automation' } });
  const res = await call();
  assert.equal(res.status, 200);
  assert.equal(res.body.reason, 'automation_mismatch');
  const run = await store.get('runs', EVENT);
  assert.equal(run.status, 'rejected');
  assert.equal(run.rendered_text, null);
});

test('clicker not in whitelist is rejected (and empty whitelist rejects everyone)', async () => {
  for (const allowed of [['00000000-0000-0000-0000-000000000000'], []]) {
    const { store, call } = setup({ button: { allowed_notion_user_ids: allowed } });
    const res = await call();
    assert.equal(res.status, 200);
    assert.equal(res.body.reason, 'clicker_not_allowed');
    assert.equal((await store.get('runs', EVENT)).clicker_notion_user_id, CLICKER);
    // Binding still happens: the request did come from the configured automation.
    assert.equal((await store.get('buttons', 'btn1')).automation_id, AUTOMATION);
  }
});

test('disabled button is rejected and not bound', async () => {
  const { store, call } = setup({ button: { enabled: false } });
  assert.equal((await call()).body.reason, 'button_disabled');
  assert.equal((await store.get('buttons', 'btn1')).automation_id, null);
});

test('missing, foreign or disabled action is rejected', async () => {
  let s = setup({ button: { action_id: null } });
  assert.equal((await s.call()).body.reason, 'no_action');
  s = setup({ action: { enabled: false } });
  assert.equal((await s.call()).body.reason, 'action_disabled');
  s = setup({ action: { owner: 'someone_else' } });
  assert.equal((await s.call()).body.reason, 'action_missing');
});

test('invalid body returns 200 without a run', async () => {
  const { store, call } = setup();
  assert.equal((await call({ body: null, bodyInvalid: true })).body.reason, 'invalid_payload');
  assert.equal((await call({ body: { source: {} } })).body.reason, 'invalid_payload');
  assert.equal(store.tables.runs.size, 0);
});

test('logs never contain the secret', async () => {
  const { call, secret, logs } = setup();
  await call();
  await call({ headers: { 'x-webhook-secret': secret + 'x' } });
  assert.ok(logs.length > 0);
  for (const line of logs) assert.ok(!line.includes(secret));
});

test('secret hashing', () => {
  const rec = newSecretRecord();
  assert.ok(verifySecret(rec.secret, rec.secret_salt, rec.secret_hash));
  assert.ok(!verifySecret(rec.secret, 'other-salt', rec.secret_hash));
  assert.ok(!verifySecret(undefined, rec.secret_salt, rec.secret_hash));
  assert.equal(hashSecret('a', 'b'), hashSecret('a', 'b'));
});
