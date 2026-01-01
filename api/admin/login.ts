import { VercelRequest, VercelResponse } from '@vercel/node';

// Simple JWT-like token issuer
function issueToken(subject: string): string {
  const payload = {
    sub: subject,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 86400 * 7, // 7 days
  };
  // In production, use a proper JWT library, but for now a simple token
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const password = String(req.body?.password || '');
  const expectedPassword = process.env.ADMIN_PASSWORD || '321$nimda';

  if (password !== expectedPassword) {
    return res.status(401).json({ error: 'invalid password' });
  }

  const token = issueToken('admin');
  return res.status(200).json({ ok: true, token });
}
