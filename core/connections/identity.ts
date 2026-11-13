// Signed "who is asking" header for a shared MCP server we run ourselves (spec, section 8.8,
// fallback path): the server checks the signature and applies the employee's rights itself.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const IDENTITY_HEADER = 'x-bba-identity';
const MAX_AGE_MS = 5 * 60 * 1000;

export interface Identity {
  userId: string;
  email: string;
  departments: string[];
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function signIdentity(identity: Identity, secret: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ ...identity, ts: now })).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

// For our own MCP servers: returns the identity, or null when the header is missing, forged or stale.
export function verifyIdentity(header: string | undefined, secret: string, now = Date.now()): Identity | null {
  const [payload, signature] = (header ?? '').split('.');
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Identity & { ts: number };
  if (Math.abs(now - parsed.ts) > MAX_AGE_MS) return null;
  return { userId: parsed.userId, email: parsed.email, departments: parsed.departments };
}
