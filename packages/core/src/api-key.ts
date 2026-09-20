import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
const SCRYPT = { N: 16384, r: 8, p: 1 } as const;
const scrypt = (secret: string, salt: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => scryptCb(secret, salt, 32, SCRYPT, (err, key) => (err ? reject(err) : resolve(key))));

/** Key format: ad_<env>_<keyId>_<secret>. Only `keyId` is stored in clear; the secret is scrypt-hashed. */
export interface GeneratedApiKey { keyId: string; secret: string; token: string }

export const generateApiKey = (env: 'live' | 'test' = 'live'): GeneratedApiKey => {
  const keyId = randomBytes(6).toString('hex');
  const secret = randomBytes(24).toString('base64url');
  return { keyId, secret, token: `ad_${env}_${keyId}_${secret}` };
};

export const parseApiKey = (token: string): { keyId: string; secret: string } | null => {
  const m = /^ad_(live|test)_([0-9a-f]{12})_([A-Za-z0-9_-]{20,})$/.exec(token);
  return m ? { keyId: m[2], secret: m[3] } : null;
};

export const hashSecret = async (secret: string, salt = randomBytes(16)): Promise<string> => {
  const key = await scrypt(secret, salt);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
};

export const verifySecret = async (secret: string, stored: string): Promise<boolean> => {
  const [alg, saltHex, keyHex] = stored.split('$');
  if (alg !== 'scrypt' || !saltHex || !keyHex) return false;
  const key = await scrypt(secret, Buffer.from(saltHex, 'hex'));
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && timingSafeEqual(key, expected);
};
