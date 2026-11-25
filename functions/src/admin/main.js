// Appwrite Function entrypoint for admin-api.
// Execute permission: "any" — every request must carry a Clerk session token
// (Authorization: Bearer <token>), verified here with @clerk/backend.
import { verifyToken } from '@clerk/backend';
import { handleAdmin } from './handler.js';
import { appwriteConfig, header, readJsonBody } from '../lib/http.js';
import { createAppwriteStore, tableIdsFromEnv } from '../lib/store.js';
import { parseEncryptionKey } from '../lib/crypto.js';

function allowedOrigins() {
  return (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function corsHeaders(origin) {
  const allowed = allowedOrigins();
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

export default async ({ req, res, log, error }) => {
  const cors = corsHeaders(header(req.headers, 'origin'));
  if (req.method === 'OPTIONS') return res.text('', 204, cors);

  if (!process.env.CLERK_SECRET_KEY && !process.env.CLERK_JWT_KEY) {
    error('admin: CLERK_SECRET_KEY or CLERK_JWT_KEY must be set');
    return res.json({ error: 'server_not_configured' }, 500, cors);
  }

  const body = readJsonBody(req);
  const store = createAppwriteStore({ ...appwriteConfig(req), tableIds: tableIdsFromEnv() });
  const origins = allowedOrigins();

  const result = await handleAdmin(
    {
      method: req.method,
      path: req.path,
      query: req.query ?? {},
      headers: req.headers ?? {},
      body: body.value,
      bodyInvalid: !body.ok,
    },
    {
      store,
      relayUrl: process.env.RELAY_URL,
      tokenKey: parseEncryptionKey(process.env.TOKEN_ENC_KEY),
      log: error,
      verifyToken: (token) =>
        verifyToken(token, {
          secretKey: process.env.CLERK_SECRET_KEY || undefined,
          jwtKey: process.env.CLERK_JWT_KEY || undefined,
          authorizedParties: origins.length ? origins : undefined,
        }),
    },
  );
  return res.json(result.body, result.status, cors);
};
