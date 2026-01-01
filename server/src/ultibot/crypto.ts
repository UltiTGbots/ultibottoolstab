import crypto from 'crypto';

/**
 * AES-256-GCM encryption for secrets at rest (e.g., bot wallet secret key).
 * Master key must be 32 bytes (base64 or hex).
 */
function getMasterKey(): Buffer {
  const raw = process.env.ULTIBOT_MASTER_KEY || '';
  if (!raw) throw new Error('ULTIBOT_MASTER_KEY is required (32 bytes base64 or hex)');
  // Try base64 then hex
  try {
    const b = Buffer.from(raw, 'base64');
    if (b.length === 32) return b;
  } catch {}
  const h = Buffer.from(raw, 'hex');
  if (h.length !== 32) throw new Error('ULTIBOT_MASTER_KEY must decode to 32 bytes');
  return h;
}

export function encryptSecret(plain: string): string {
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // format: v1:<b64(iv)>:<b64(tag)>:<b64(ciphertext)>
  return ['v1', iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

export function decryptSecret(payload: string): string {
  const key = getMasterKey();
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Invalid secret payload');
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const data = Buffer.from(parts[3], 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString('utf8');
}
