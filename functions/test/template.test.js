import { test } from 'node:test';
import assert from 'node:assert/strict';
import payload from '../fixtures/notion-button-payload.json' with { type: 'json' };
import { parseWebhookPayload } from '../src/lib/notion.js';
import { buildVariables, renderTemplate, templateVariables } from '../src/lib/template.js';

const vars = buildVariables(parseWebhookPayload(payload).event);

test('renders property and built-in variables', () => {
  const tpl = '请补全「{{知识点}}」（{{小节}}，教材第 {{ 教材页码 }} 页）。\n页面：{{page_url}}\nID：{{page_id}}';
  const { text, missing, empty } = renderTemplate(tpl, vars);
  assert.equal(
    text,
    '请补全「费马引理」（3.1 微分中值定理，教材第 122 页）。\n页面：https://app.notion.com/p/41ac41ba134481baa977faa8f09d07d0\nID：41ac41ba-1344-81ba-a977-faa8f09d07d0',
  );
  assert.deepEqual(missing, []);
  assert.deepEqual(empty, []);
});

test('reports unknown and empty variables', () => {
  const { text, missing, empty } = renderTemplate('{{不存在}}|{{考试范围}}|{{后续知识}}', vars);
  assert.equal(text, '||41ac41ba-1344-810e-897e-d66f899be576, 41ac41ba-1344-81cc-bd1c-f84822d47352');
  assert.deepEqual(missing, ['不存在']);
  assert.deepEqual(empty, ['考试范围']);
});

test('property names with slashes work and values are not re-expanded', () => {
  const v = { ...vars, 'a/b': '{{知识点}}' };
  assert.equal(renderTemplate('{{a/b}}', v).text, '{{知识点}}');
});

test('properties variable lists non-empty properties', () => {
  const { text } = renderTemplate('{{properties}}', vars);
  assert.match(text, /^掌握程度: 待复习$/m);
  assert.match(text, /^知识点: 费马引理$/m);
  assert.doesNotMatch(text, /考试范围/);
});

test('templateVariables lists used names once', () => {
  assert.deepEqual(templateVariables('{{a}} {{ b }} {{a}}'), ['a', 'b']);
});
