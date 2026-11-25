// Application-level encryption for Claude routine tokens (AES-256-GCM).
// The key comes from the TOKEN_ENC_KEY environment variable: 32 bytes, base64 or hex encoded.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';

/** Parse TOKEN_ENC_KEY; returns a 32-byte Buffer or null if missing/invalid. */
export function parseEncryptionKey(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const s = raw.trim();
  let key = null;
  if (/^[0-9a-fA-F]{64}$/.test(s)) key = Buffer.from(s, 'hex');
  else key = Buffer.from(s, 'base64');
  return key.length === 32 ? key : null;
}

/** Encrypt a token. Output: "v1.<iv>.<tag>.<ciphertext>" (base64url parts). */
export function encryptToken(plain, key) {
  if (!key) throw new Error('encryption key not configured');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptToken(blob, key) {
  if (!key) throw new Error('encryption key not configured');
  const parts = String(blob ?? '').split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('unsupported ciphertext');
  const [, iv, tag, ct] = parts.map((p, i) => (i === 0 ? p : Buffer.from(p, 'base64url')));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
