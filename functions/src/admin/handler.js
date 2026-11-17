// admin-api: backend for the admin site. Every route requires a valid Clerk session token,
// and every row is scoped to the Clerk user ID (`owner`).
import { buildVariables, renderTemplate, templateVariables, BUILTIN_VARIABLES, MAX_TEXT_LENGTH } from '../lib/template.js';
import { parseWebhookPayload } from '../lib/notion.js';
import { generateId, newSecretRecord } from '../lib/secrets.js';
import { header, isValidRowId } from '../lib/http.js';
import { REJECT_REASONS, SECRET_HEADER } from '../relay/handler.js';
import samplePayload from '../../fixtures/notion-button-payload.json' with { type: 'json' };

class HttpError extends Error {
  constructor(status, code, message) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

const NOTION_USER_ID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const MAX_TEMPLATE_LENGTH = 60000;
const MAX_ALLOWED_USERS = 50;

// ---------- validation helpers ----------

function requireObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'invalid_body');
  return body;
}

function str(value, field, { min = 0, max = 256, optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_field', `${field} 必须是字符串`);
  const v = value.trim();
  if (v.length < min || v.length > max) throw new HttpError(400, 'invalid_field', `${field} 长度需在 ${min}–${max} 之间`);
  return v;
}

function bool(value, field, { optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'boolean') throw new HttpError(400, 'invalid_field', `${field} 必须是布尔值`);
  return value;
}

/** Normalise Notion user IDs to the dashed lowercase form used in webhook payloads. */
export function normaliseNotionUserId(id) {
  const hex = id.replace(/-/g, '').toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function userIds(value, { optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (!Array.isArray(value)) throw new HttpError(400, 'invalid_field', 'allowed_notion_user_ids 必须是数组');
  if (value.length > MAX_ALLOWED_USERS) throw new HttpError(400, 'invalid_field', `白名单最多 ${MAX_ALLOWED_USERS} 人`);
  const out = [];
  for (const raw of value) {
    if (typeof raw !== 'string' || !NOTION_USER_ID_RE.test(raw.trim())) {
      throw new HttpError(400, 'invalid_field', `不是有效的 Notion 用户 ID：${String(raw).slice(0, 64)}`);
    }
    const id = normaliseNotionUserId(raw.trim());
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

// ---------- serialisers (never expose secret material) ----------

function publicButton(row, relayUrl) {
  return {
    id: row.$id,
    name: row.name,
    action_id: row.action_id ?? null,
    allowed_notion_user_ids: row.allowed_notion_user_ids ?? [],
    enabled: Boolean(row.enabled),
    automation_id: row.automation_id ?? null,
    bound: Boolean(row.automation_id),
    webhook_url: webhookUrl(relayUrl, row.$id),
    secret_header: SECRET_HEADER,
    created_at: row.$createdAt,
    updated_at: row.$updatedAt,
  };
}

function publicAction(row) {
  return {
    id: row.$id,
    name: row.name,
    prompt_template: row.prompt_template,
    enabled: Boolean(row.enabled),
    created_at: row.$createdAt,
    updated_at: row.$updatedAt,
  };
}

function publicRun(row) {
  return {
    id: row.$id,
    button_id: row.button_id,
    action_id: row.action_id ?? null,
    status: row.status,
    reject_reason: row.reject_reason ?? null,
    reject_reason_text: row.reject_reason ? (REJECT_REASONS[row.reject_reason] ?? row.reject_reason) : null,
    page_id: row.page_id ?? null,
    page_url: row.page_url ?? null,
    page_title: row.page_title ?? null,
    clicker_notion_user_id: row.clicker_notion_user_id ?? null,
    automation_id: row.automation_id ?? null,
    attempt: row.attempt ?? null,
    rendered_text: row.rendered_text ?? null,
    missing_variables: row.missing_variables ?? [],
    session_url: row.session_url ?? null,
    error: row.error ?? null,
    created_at: row.$createdAt,
  };
}

export function webhookUrl(relayUrl, buttonId) {
  if (!relayUrl) return null;
  const url = new URL(relayUrl);
  url.searchParams.set('b', buttonId);
  return url.toString();
}

// ---------- ownership ----------

async function ownedRow(store, table, id, owner) {
  if (!isValidRowId(id)) throw new HttpError(404, 'not_found');
  const row = await store.get(table, id);
  if (!row || row.owner !== owner) throw new HttpError(404, 'not_found');
  return row;
}

async function assertOwnedAction(store, actionId, owner) {
  if (actionId === null) return;
  await ownedRow(store, 'actions', actionId, owner).catch(() => {
    throw new HttpError(400, 'invalid_field', '所选操作不存在');
  });
}

// ---------- routes ----------

function preview(template, payload) {
  const parsed = parseWebhookPayload(payload ?? samplePayload);
  if (!parsed.ok) throw new HttpError(400, 'invalid_payload', `示例 payload 无效：${parsed.reason}`);
  const vars = buildVariables(parsed.event);
  const rendered = renderTemplate(template, vars);
  return {
    ...rendered,
    used_variables: templateVariables(template),
    available_variables: [
      ...Object.entries(BUILTIN_VARIABLES).map(([name, description]) => ({ name, description, builtin: true })),
      ...Object.keys(parsed.event.properties).map((name) => ({ name, builtin: false })),
    ],
    max_length: MAX_TEXT_LENGTH,
  };
}

const routes = [
  ['GET', /^\/me$/, async ({ owner }) => ({ user_id: owner })],

  // Actions (prompt templates)
  ['GET', /^\/actions$/, async ({ store, owner }) => {
    const { rows } = await store.list('actions', { where: { owner }, limit: 100 });
    return { actions: rows.map(publicAction) };
  }],
  ['POST', /^\/actions$/, async ({ store, owner, body }) => {
    const b = requireObject(body);
    const row = await store.create('actions', generateId(), {
      owner,
      name: str(b.name, 'name', { min: 1, max: 128 }),
      prompt_template: str(b.prompt_template ?? '', 'prompt_template', { max: MAX_TEMPLATE_LENGTH }),
      enabled: bool(b.enabled ?? true, 'enabled'),
    });
    return { status: 201, body: { action: publicAction(row) } };
  }],
  ['PATCH', /^\/actions\/([^/]+)$/, async ({ store, owner, body, params }) => {
    await ownedRow(store, 'actions', params[0], owner);
    const b = requireObject(body);
    const patch = stripUndefined({
      name: str(b.name, 'name', { min: 1, max: 128, optional: true }),
      prompt_template: str(b.prompt_template, 'prompt_template', { max: MAX_TEMPLATE_LENGTH, optional: true }),
      enabled: bool(b.enabled, 'enabled', { optional: true }),
    });
    const row = await store.update('actions', params[0], patch);
    return { action: publicAction(row) };
  }],
  ['DELETE', /^\/actions\/([^/]+)$/, async ({ store, owner, params }) => {
    await ownedRow(store, 'actions', params[0], owner);
    const { total } = await store.list('buttons', { where: { owner, action_id: params[0] }, limit: 1 });
    if (total > 0) throw new HttpError(409, 'action_in_use', '还有按钮在使用这个操作，请先改掉按钮的操作');
    await store.delete('actions', params[0]);
    return { ok: true };
  }],
  ['POST', /^\/preview$/, async ({ body }) => {
    const b = requireObject(body);
    const template = str(b.prompt_template ?? '', 'prompt_template', { max: MAX_TEMPLATE_LENGTH });
    return preview(template, b.payload);
  }],

  // Buttons
  ['GET', /^\/buttons$/, async ({ store, owner, relayUrl }) => {
    const { rows } = await store.list('buttons', { where: { owner }, limit: 100 });
    return { buttons: rows.map((r) => publicButton(r, relayUrl)) };
  }],
  ['POST', /^\/buttons$/, async ({ store, owner, body, relayUrl }) => {
    const b = requireObject(body);
    const actionId = b.action_id === undefined || b.action_id === null ? null : str(b.action_id, 'action_id', { min: 1, max: 36 });
    await assertOwnedAction(store, actionId, owner);
    const { secret, secret_salt, secret_hash } = newSecretRecord();
    const row = await store.create('buttons', generateId(), {
      owner,
      name: str(b.name, 'name', { min: 1, max: 128 }),
      action_id: actionId,
      allowed_notion_user_ids: userIds(b.allowed_notion_user_ids ?? []),
      enabled: bool(b.enabled ?? true, 'enabled'),
      automation_id: null,
      secret_salt,
      secret_hash,
    });
    // The plain secret is returned exactly once and never stored.
    return { status: 201, body: { button: publicButton(row, relayUrl), secret } };
  }],
  ['PATCH', /^\/buttons\/([^/]+)$/, async ({ store, owner, body, params, relayUrl }) => {
    await ownedRow(store, 'buttons', params[0], owner);
    const b = requireObject(body);
    let actionId;
    if (b.action_id !== undefined) {
      actionId = b.action_id === null ? null : str(b.action_id, 'action_id', { min: 1, max: 36 });
      await assertOwnedAction(store, actionId, owner);
    }
    const patch = stripUndefined({
      name: str(b.name, 'name', { min: 1, max: 128, optional: true }),
      action_id: actionId,
      allowed_notion_user_ids: userIds(b.allowed_notion_user_ids, { optional: true }),
      enabled: bool(b.enabled, 'enabled', { optional: true }),
    });
    const row = await store.update('buttons', params[0], patch);
    return { button: publicButton(row, relayUrl) };
  }],
  ['POST', /^\/buttons\/([^/]+)\/rotate-secret$/, async ({ store, owner, params, relayUrl }) => {
    await ownedRow(store, 'buttons', params[0], owner);
    const { secret, secret_salt, secret_hash } = newSecretRecord();
    const row = await store.update('buttons', params[0], { secret_salt, secret_hash });
    return { button: publicButton(row, relayUrl), secret };
  }],
  ['POST', /^\/buttons\/([^/]+)\/unbind$/, async ({ store, owner, params, relayUrl }) => {
    await ownedRow(store, 'buttons', params[0], owner);
    const row = await store.update('buttons', params[0], { automation_id: null });
    return { button: publicButton(row, relayUrl) };
  }],
  ['DELETE', /^\/buttons\/([^/]+)$/, async ({ store, owner, params }) => {
    await ownedRow(store, 'buttons', params[0], owner);
    await store.delete('buttons', params[0]);
    return { ok: true };
  }],

  // Runs
  ['GET', /^\/runs$/, async ({ store, owner, query }) => {
    const where = { owner };
    if (query.button_id) {
      if (!isValidRowId(query.button_id)) throw new HttpError(400, 'invalid_field');
      where.button_id = query.button_id;
    }
    if (query.status) {
      if (!['queued', 'rejected', 'dispatched', 'failed', 'done'].includes(query.status)) throw new HttpError(400, 'invalid_field');
      where.status = query.status;
    }
    const limit = Math.min(Math.max(Number.parseInt(query.limit ?? '25', 10) || 25, 1), 100);
    const cursor = query.cursor && isValidRowId(query.cursor) ? query.cursor : undefined;
    if (cursor) await ownedRow(store, 'runs', cursor, owner);
    const { rows, total } = await store.list('runs', { where, limit, cursorAfter: cursor });
    return {
      runs: rows.map(publicRun),
      total,
      next_cursor: rows.length === limit ? rows[rows.length - 1].$id : null,
    };
  }],
  ['GET', /^\/runs\/([^/]+)$/, async ({ store, owner, params }) => {
    const row = await ownedRow(store, 'runs', params[0], owner);
    return { run: publicRun(row) };
  }],
];

function stripUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/** Normalise the request path: drop query string, trailing slash and an optional /api prefix. */
export function normalisePath(path) {
  let p = String(path || '/').split('?')[0];
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  if (p === '/api') return '/';
  if (p.startsWith('/api/')) p = p.slice(4);
  return p;
}

/**
 * @param {{ method: string, path: string, query: object, headers: object, body: unknown, bodyInvalid?: boolean }} request
 * @param {{ store: object, verifyToken: (token: string) => Promise<{ sub: string }>, relayUrl?: string, log?: Function }} deps
 */
export async function handleAdmin(request, deps) {
  const log = deps.log ?? (() => {});
  try {
    const auth = header(request.headers, 'authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    if (!match) throw new HttpError(401, 'unauthenticated');
    let owner;
    try {
      const claims = await deps.verifyToken(match[1].trim());
      owner = claims?.sub;
    } catch {
      throw new HttpError(401, 'unauthenticated');
    }
    if (typeof owner !== 'string' || !owner) throw new HttpError(401, 'unauthenticated');

    if (request.bodyInvalid) throw new HttpError(400, 'invalid_json');

    const method = String(request.method || 'GET').toUpperCase();
    const path = normalisePath(request.path);
    let pathMatched = false;
    for (const [m, re, fn] of routes) {
      const found = re.exec(path);
      if (!found) continue;
      pathMatched = true;
      if (m !== method) continue;
      const result = await fn({
        store: deps.store,
        owner,
        body: request.body,
        query: request.query ?? {},
        params: found.slice(1).map(decodeURIComponent),
        relayUrl: deps.relayUrl,
      });
      if (result && typeof result.status === 'number' && 'body' in result) return result;
      return { status: 200, body: result };
    }
    throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'method_not_allowed' : 'not_found');
  } catch (e) {
    if (e instanceof HttpError) {
      return { status: e.status, body: { error: e.code, message: e.message !== e.code ? e.message : undefined } };
    }
    log(`admin: unexpected error: ${e?.message ?? e}`);
    return { status: 500, body: { error: 'internal_error' } };
  }
}
