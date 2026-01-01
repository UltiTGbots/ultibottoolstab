import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';

function hmac(data: string): string {
  const secret = process.env.SESSION_SECRET || '';
  if (!secret) throw new Error('SESSION_SECRET is required');
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

export function issueToken(sub: string): string {
  const payload = {
    sub,
    iat: Date.now(),
    exp: Date.now() + 1000 * 60 * 60 * 12, // 12h
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = hmac(body);
  return `${body}.${sig}`;
}

export function verifyToken(token: string): { sub: string } | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  if (hmac(body) !== sig) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
    if (typeof payload.sub !== 'string') return null;
    return { sub: payload.sub };
  } catch {
    return null;
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const auth = String(req.headers.authorization || '');
  console.log('Auth header received:', auth.substring(0, 20) + '...');
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  console.log('Token extracted:', token ? 'present' : 'missing');
  const ok = token ? verifyToken(token) : null;
  console.log('Token verification result:', ok ? 'valid' : 'invalid');
  if (!ok) return res.status(401).json({ error: 'unauthorized' });
  (req as any).admin = ok.sub;
  next();
}
