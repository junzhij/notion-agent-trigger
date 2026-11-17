// notion-relay: receives Notion "Send webhook" calls and records them as runs.
//
// Notion pauses an automation after a non-2xx response, so every business-level rejection
// returns 200 and is recorded instead. The only exception is a wrong/missing secret
// (configurable, default 401), so that a misconfigured button is noticed.
//
// The AI dispatch step is intentionally not implemented yet: accepted clicks are stored with
// status "queued" and the rendered prompt in `rendered_text`, ready for a future executor.
import { parseWebhookPayload } from '../lib/notion.js';
import { buildVariables, renderTemplate } from '../lib/template.js';
import { verifySecret } from '../lib/secrets.js';
import { ConflictError } from '../lib/store.js';
import { header, isValidRowId } from '../lib/http.js';

export const SECRET_HEADER = 'x-webhook-secret';

export const REJECT_REASONS = {
  button_disabled: '按钮已停用',
  automation_mismatch: '请求来自另一个 Notion 自动化（automation_id 与绑定的不一致）',
  clicker_not_allowed: '点击者不在白名单中',
  no_action: '按钮未配置操作',
  action_missing: '按钮配置的操作不存在',
  action_disabled: '按钮配置的操作已停用',
};

const ok = (body) => ({ status: 200, body });

/**
 * @param {{ query: Record<string,string>, headers: Record<string,string>, body: unknown, bodyInvalid?: boolean }} request
 * @param {{ store: ReturnType<import('../lib/store.js').createMemoryStore>, log?: Function, badSecretStatus?: number }} deps
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function handleRelay(request, deps) {
  const { store } = deps;
  const log = deps.log ?? (() => {});
  const badSecretStatus = deps.badSecretStatus ?? 401;

  // 1. Button lookup
  const buttonId = request.query?.b;
  if (!isValidRowId(buttonId)) {
    log('relay: missing or malformed button id');
    return ok({ ok: false, reason: 'unknown_button' });
  }
  const button = await store.get('buttons', buttonId);
  if (!button) {
    log(`relay: unknown button ${buttonId}`);
    return ok({ ok: false, reason: 'unknown_button' });
  }

  // 2. Secret check (constant time)
  const presented = header(request.headers, SECRET_HEADER);
  if (!verifySecret(presented, button.secret_salt, button.secret_hash)) {
    log(`relay: bad secret for button ${buttonId}`);
    return { status: badSecretStatus, body: { ok: false, reason: 'bad_secret' } };
  }

  // Payload
  if (request.bodyInvalid) {
    log(`relay: invalid JSON body for button ${buttonId}`);
    return ok({ ok: false, reason: 'invalid_payload' });
  }
  const parsed = parseWebhookPayload(request.body);
  if (!parsed.ok) {
    log(`relay: invalid payload for button ${buttonId}: ${parsed.reason}`);
    return ok({ ok: false, reason: 'invalid_payload' });
  }
  const event = parsed.event;
  if (!isValidRowId(event.eventId)) {
    log(`relay: unusable event id for button ${buttonId}`);
    return ok({ ok: false, reason: 'invalid_payload' });
  }

  // Cheap early dedupe for retries (the create below is the authoritative check).
  if (await store.get('runs', event.eventId)) {
    log(`relay: duplicate event ${event.eventId}`);
    return ok({ ok: true, duplicate: true, run_id: event.eventId });
  }

  let rejectReason = null;
  let action = null;

  if (!button.enabled) {
    rejectReason = 'button_disabled';
  }

  // 3. automation_id binding
  if (!rejectReason) {
    if (!button.automation_id) {
      if (event.automationId) {
        await store.update('buttons', button.$id, { automation_id: event.automationId });
        log(`relay: bound button ${buttonId} to automation ${event.automationId}`);
      }
    } else if (button.automation_id !== event.automationId) {
      rejectReason = 'automation_mismatch';
    }
  }

  // 4. Clicker whitelist (empty list = nobody allowed)
  if (!rejectReason) {
    const allowed = Array.isArray(button.allowed_notion_user_ids) ? button.allowed_notion_user_ids : [];
    if (!event.clickerId || !allowed.includes(event.clickerId)) rejectReason = 'clicker_not_allowed';
  }

  // 6. Load the action and render its prompt
  let rendered = null;
  if (!rejectReason) {
    if (!button.action_id) {
      rejectReason = 'no_action';
    } else {
      action = await store.get('actions', button.action_id);
      if (!action || action.owner !== button.owner) rejectReason = 'action_missing';
      else if (!action.enabled) rejectReason = 'action_disabled';
      else rendered = renderTemplate(action.prompt_template, buildVariables(event));
    }
  }

  // 5. Record the run, keyed by event_id (dedupe on conflict)
  const run = {
    owner: button.owner,
    button_id: button.$id,
    action_id: action?.$id ?? button.action_id ?? null,
    status: rejectReason ? 'rejected' : 'queued',
    reject_reason: rejectReason,
    page_id: event.pageId,
    page_url: event.pageUrl,
    page_title: truncate(event.title, 512),
    clicker_notion_user_id: event.clickerId,
    automation_id: event.automationId,
    attempt: event.attempt,
    rendered_text: rendered ? rendered.text : null,
    missing_variables: rendered ? rendered.missing : [],
    session_url: null,
    error: rendered?.tooLong ? 'rendered_text_too_long' : null,
  };

  try {
    await store.create('runs', event.eventId, run);
  } catch (e) {
    if (e instanceof ConflictError) {
      log(`relay: duplicate event ${event.eventId}`);
      return ok({ ok: true, duplicate: true, run_id: event.eventId });
    }
    throw e;
  }

  log(`relay: event ${event.eventId} button ${buttonId} → ${run.status}${rejectReason ? ` (${rejectReason})` : ''}`);
  return ok({ ok: !rejectReason, status: run.status, reason: rejectReason, run_id: event.eventId });
}

function truncate(value, max) {
  if (typeof value !== 'string') return null;
  return value.length > max ? value.slice(0, max) : value;
}
