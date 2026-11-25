// Appwrite Function entrypoint for notion-relay.
// Execute permission: "any" — security relies on the per-button secret, automation binding
// and clicker whitelist checked in handler.js.
import { handleRelay } from './handler.js';
import { appwriteConfig, readJsonBody } from '../lib/http.js';
import { createAppwriteStore, tableIdsFromEnv } from '../lib/store.js';
import { parseEncryptionKey } from '../lib/crypto.js';

export default async ({ req, res, log, error }) => {
  if (req.method !== 'POST') {
    return res.json({ ok: true, service: 'notion-relay' }, 200);
  }

  const body = readJsonBody(req);
  const store = createAppwriteStore({ ...appwriteConfig(req), tableIds: tableIdsFromEnv() });
  const badSecretStatus = Number(process.env.BAD_SECRET_STATUS) || 401;

  try {
    const result = await handleRelay(
      { query: req.query ?? {}, headers: req.headers ?? {}, body: body.value, bodyInvalid: !body.ok },
      { store, log, badSecretStatus, tokenKey: parseEncryptionKey(process.env.TOKEN_ENC_KEY) },
    );
    return res.json(result.body, result.status);
  } catch (e) {
    // Never log headers or secrets; the message alone is enough.
    error(`relay: unexpected error: ${e?.message ?? e}`);
    // 200 so Notion does not pause the automation on a transient backend error.
    return res.json({ ok: false, reason: 'internal_error' }, 200);
  }
};
