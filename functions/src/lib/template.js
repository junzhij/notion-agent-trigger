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
