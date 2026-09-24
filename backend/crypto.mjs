import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const OPTIONS = { N: 16384, r: 8, p: 5, maxmem: 64 * 1024 * 1024 };
export const DUMMY_PASSWORD_HASH = `scrypt$16384$8$5$${'00'.repeat(16)}$${'00'.repeat(64)}`;

export function validPassword(password) {
  return typeof password === 'string' && password.length >= 10 && password.length <= 128;
}

export async function hashPassword(password) {
  if (!validPassword(password)) throw new TypeError('Password length must be 10–128 characters');
  const salt = randomBytes(16);
  const key = await derive(password, salt, 64, OPTIONS);
  return `scrypt$16384$8$5$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password, encoded) {
  if (!validPassword(password) || typeof encoded !== 'string') return false;
  const match = /^scrypt\$16384\$8\$5\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(encoded);
  if (!match) return false;
  const expected = Buffer.from(match[2], 'hex');
  const actual = await derive(password, Buffer.from(match[1], 'hex'), 64, OPTIONS);
  return timingSafeEqual(actual, expected);
}

export const randomToken = () => randomBytes(32).toString('base64url');
export const sha256 = value => createHash('sha256').update(value).digest('hex');
