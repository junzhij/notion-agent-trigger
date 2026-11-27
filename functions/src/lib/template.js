// Prompt template rendering. Variables look like {{知识点}} or {{ page_url }}.
// Rendering is single-pass, so values containing "{{...}}" are never expanded again.

export const MAX_TEXT_LENGTH = 65536;

const VARIABLE_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** Variables that are always available, in addition to the page's property names. */
export const BUILTIN_VARIABLES = {
  page_id: 'Notion 页面 ID',
  page_url: 'Notion 页面链接',
  public_url: '公开发布链接（未发布时为空）',
  page_title: '页面标题（title 属性的值）',
  database_id: '数据库 ID',
  data_source_id: '数据源 ID',
  clicker_id: '点击者的 Notion 用户 ID',
  event_id: '本次点击的事件 ID',
  properties: '所有属性，每行「名称: 值」',
};

export function formatValue(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(formatValue).filter((v) => v !== '').join(', ');
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}

function formatPropertyList(properties) {
  return Object.entries(properties)
    .map(([name, value]) => [name, formatValue(value)])
    .filter(([, v]) => v !== '')
    .map(([name, v]) => `${name}: ${v}`)
    .join('\n');
}

/** Build the variable map for a parsed webhook event (see notion.parseWebhookPayload). */
export function buildVariables(event) {
  const vars = {};
  for (const [name, value] of Object.entries(event.properties ?? {})) {
    vars[name] = value;
  }
  // Built-ins win over same-named properties so templates stay predictable.
  Object.assign(vars, {
    page_id: event.pageId,
    page_url: event.pageUrl,
    public_url: event.publicUrl,
    page_title: event.title,
    database_id: event.databaseId,
    data_source_id: event.dataSourceId,
    clicker_id: event.clickerId,
    event_id: event.eventId,
    properties: formatPropertyList(event.properties ?? {}),
  });
  return vars;
}

/** Names of variables used in a template, in order of first appearance. */
export function templateVariables(template) {
  const seen = new Set();
  for (const m of String(template ?? '').matchAll(VARIABLE_RE)) seen.add(m[1]);
  return [...seen];
}

/**
 * Render a template. Unknown variables become empty strings and are reported in `missing`;
 * known variables whose value is empty are reported in `empty`.
 */
export function renderTemplate(template, vars) {
  const missing = new Set();
  const empty = new Set();
  const text = String(template ?? '').replace(VARIABLE_RE, (_, name) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) {
      missing.add(name);
      return '';
    }
    const formatted = formatValue(vars[name]);
    if (formatted === '') empty.add(name);
    return formatted;
  });
  return {
    text,
    missing: [...missing],
    empty: [...empty],
    tooLong: text.length > MAX_TEXT_LENGTH,
  };
}

/**
 * Final text sent to the routine: a fixed header naming the target page (the generic routine
 * prompt relies on it), followed by the rendered action template.
 */
export function composeDispatchText(vars, renderedText) {
  const header = [
    '[Notion 按钮触发]',
    `页面标题：${formatValue(vars.page_title)}`,
    `page_id：${formatValue(vars.page_id)}`,
    `page_url：${formatValue(vars.page_url)}`,
  ].join('\n');
  const text = `${header}\n\n${renderedText ?? ''}`.trimEnd();
  return { text, tooLong: text.length > MAX_TEXT_LENGTH };
}

/**
 * Default action template generated after a button's setup test: the page's parameters plus
 * the instruction to act on @claude comments. (page_id / page_url come from the dispatch header.)
 */
export function defaultTemplate(propertyNames = []) {
  const lines = propertyNames.map((name) => `- ${name}：{{${name}}}`);
  return [
    '请处理上面这个 Notion 页面（page_id：{{page_id}}）。',
    '',
    '页面参数：',
    ...(lines.length ? lines : ['{{properties}}']),
    '',
    '步骤：',
    '1. 用 Notion 连接器读取这个页面的正文，以及页面上的所有评论（包括行内评论）。',
    '2. 找出提到 @claude 的评论，它们就是这次要做的事；你已经回复过的评论跳过。',
    '3. 按评论的要求修改这个页面，然后在对应评论下回复，简要说明改了什么。',
    '4. 如果没有待处理的 @claude 评论，不要改动页面，直接结束。',
  ].join('\n');
}
