import { test } from 'node:test';
import assert from 'node:assert/strict';
import payload from '../fixtures/notion-button-payload.json' with { type: 'json' };
import { extractProperties, parseWebhookPayload, propertyValue } from '../src/lib/notion.js';

test('extracts every property type in the real payload', () => {
  const props = extractProperties(payload.data.properties);
  assert.equal(props['知识点'], '费马引理');
  assert.equal(props['掌握程度'], '待复习');
  assert.equal(props['小节'], '3.1 微分中值定理');
  assert.equal(props['章节'], '第三章 微分中值定理与导数的应用');
  assert.equal(props['类型'], '定理/性质');
  assert.equal(props['重要度'], '★★ 常考');
  assert.equal(props['来源'], '课堂');
  assert.equal(props['复习次数'], 1);
  assert.equal(props['教材页码'], 122);
  assert.deepEqual(props['考试范围'], []);
  assert.deepEqual(props['前置知识'], []);
  assert.deepEqual(props['后续知识'], ['41ac41ba-1344-810e-897e-d66f899be576', '41ac41ba-1344-81cc-bd1c-f84822d47352']);
  assert.deepEqual(props['手写/截图'], []);
  assert.equal(props['编号'], 'GS-NOTE-2');
  assert.equal(props['最后编辑'], '2026-11-16T06:55:00.000Z');
});

test('parses source and page metadata', () => {
  const parsed = parseWebhookPayload(payload);
  assert.equal(parsed.ok, true);
  const e = parsed.event;
  assert.equal(e.eventId, '87ed7111-8bb7-4443-8314-b9e051609b28');
  assert.equal(e.attempt, 1);
  assert.equal(e.automationId, '846eaf78-5fd3-40a7-bee7-81ab17aca77e');
  assert.equal(e.clickerId, '1bfd872b-594c-81a2-9a19-0002e093b3e1');
  assert.equal(e.pageId, '41ac41ba-1344-81ba-a977-faa8f09d07d0');
  assert.equal(e.pageUrl, 'https://app.notion.com/p/41ac41ba134481baa977faa8f09d07d0');
  assert.equal(e.databaseId, '41ac41ba-1344-8157-b3cc-d257711f7504');
  assert.equal(e.dataSourceId, '41ac41ba-1344-8193-a82c-000bb87f6121');
  assert.equal(e.title, '费马引理');
});

test('rejects malformed payloads', () => {
  assert.equal(parseWebhookPayload(null).ok, false);
  assert.equal(parseWebhookPayload({}).ok, false);
  assert.equal(parseWebhookPayload({ source: {}, data: {} }).reason, 'missing_event_id');
});

test('handles other property types', () => {
  assert.equal(propertyValue({ type: 'rich_text', rich_text: [{ plain_text: 'a' }, { plain_text: 'b' }] }), 'ab');
  assert.equal(propertyValue({ type: 'checkbox', checkbox: true }), true);
  assert.equal(propertyValue({ type: 'date', date: { start: '2026-01-01', end: '2026-01-02' } }), '2026-01-01 → 2026-01-02');
  assert.equal(propertyValue({ type: 'formula', formula: { type: 'number', number: 3 } }), 3);
  assert.deepEqual(
    propertyValue({ type: 'rollup', rollup: { type: 'array', array: [{ type: 'number', number: 1 }, { type: 'title', title: [{ plain_text: 'x' }] }] } }),
    [1, 'x'],
  );
  assert.deepEqual(propertyValue({ type: 'people', people: [{ id: 'u1', name: 'Ann' }, { id: 'u2' }] }), ['Ann', 'u2']);
  assert.equal(propertyValue({ type: 'select', select: null }), null);
  assert.equal(propertyValue({ type: 'button', button: {} }), null);
});
