import { useAuth } from '@clerk/react';
import { useCallback } from 'react';

const BASE = String(import.meta.env.VITE_ADMIN_API_URL || '').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || body?.error || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

/** Returns `api(method, path, body?)` that sends the Clerk session token. */
export function useApi() {
  const { getToken } = useAuth();
  return useCallback(
    async (method, path, body) => {
      const token = await getToken();
      const res = await fetch(`${BASE}/api${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(res.status, data);
      return data;
    },
    [getToken],
  );
}
