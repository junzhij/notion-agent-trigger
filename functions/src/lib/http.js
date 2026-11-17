// Helpers shared by the Appwrite function adapters.

/** Case-insensitive header lookup. */
export function header(headers, name) {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

/** Parse a JSON body from an Appwrite request without throwing. */
export function readJsonBody(req) {
  const raw = typeof req.bodyText === 'string' ? req.bodyText : typeof req.body === 'string' ? req.body : null;
  if (raw !== null) {
    if (raw.trim() === '') return { ok: true, value: null };
    try {
      return { ok: true, value: JSON.parse(raw) };
    } catch {
      return { ok: false, value: null };
    }
  }
  if (req.body && typeof req.body === 'object') return { ok: true, value: req.body };
  return { ok: true, value: null };
}

/** Appwrite row IDs: ≤36 chars of [A-Za-z0-9._-], not starting with a special char. */
export function isValidRowId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(id);
}

/** Build an Appwrite server client config for the current execution. */
export function appwriteConfig(req, env = process.env) {
  return {
    endpoint: env.APPWRITE_FUNCTION_API_ENDPOINT || env.APPWRITE_ENDPOINT,
    projectId: env.APPWRITE_FUNCTION_PROJECT_ID || env.APPWRITE_PROJECT_ID,
    // Dynamic per-execution key (function scopes), falling back to a configured key.
    apiKey: header(req.headers, 'x-appwrite-key') || env.APPWRITE_API_KEY,
    databaseId: env.DATABASE_ID || 'notion_agent',
  };
}
