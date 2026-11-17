import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** New high-entropy webhook secret, shown to the user exactly once. */
export function generateSecret() {
  return `nwh_${randomBytes(32).toString('base64url')}`;
}

export function generateSalt() {
  return randomBytes(16).toString('hex');
}

/** New row ID: 20 hex chars, valid as an Appwrite row ID. */
export function generateId() {
  return randomBytes(10).toString('hex');
}

export function hashSecret(secret, salt) {
  return createHash('sha256').update(`${salt}:${secret}`, 'utf8').digest('hex');
}

/** Constant-time check of a presented secret against the stored salt + hash. */
export function verifySecret(presented, salt, expectedHash) {
  if (typeof presented !== 'string' || !presented) return false;
  if (typeof salt !== 'string' || typeof expectedHash !== 'string') return false;
  const actual = Buffer.from(hashSecret(presented, salt), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** Create the stored form of a fresh secret. */
export function newSecretRecord() {
  const secret = generateSecret();
  const salt = generateSalt();
  return { secret, secret_salt: salt, secret_hash: hashSecret(secret, salt) };
}
