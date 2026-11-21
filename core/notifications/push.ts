// Web Push (docs/specs/[20.11.2026]-notifications.md, sections 8 and 18): the VAPID keys of the installation and one
// send of an encrypted push to a browser's push service. `web-push` 3.6.7 builds the request (aes128gcm encryption,
// the VAPID signature); we send it ourselves — over https, only to public addresses (the address of a subscription
// comes from a browser, so a person could give an inner one of our server), with a time limit — and read the answer
// as one of: delivered, the subscription is dead, try again later, or refused.
import https from 'node:https';
import { createRequire } from 'node:module';
import type { PushPayload } from '@bba/contracts';
import type { SecretBox } from '../crypto/secret-box.ts';
import type { Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import { assertPublicLiteral, publicLookup } from '../net/public-address.ts';

// web-push is CommonJS without an ESM entry.
const webpush = createRequire(import.meta.url)('web-push') as typeof import('web-push');

export const PUSH_TIMEOUT_MS = 10_000;

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

// Made at the first start and kept: a new pair would make every subscription of every browser useless (403).
export async function ensureVapidKeys(db: Db, box: SecretBox): Promise<VapidKeys> {
  const fresh = webpush.generateVAPIDKeys();
  const sealed = box.seal(fresh.privateKey);
  await db.query(
    'INSERT INTO app.notification_keys (id, public_key, private_ciphertext, private_iv, key_version) VALUES (1, $1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
    [fresh.publicKey, sealed.ciphertext, sealed.iv, sealed.keyVersion],
  );
  const { rows } = await db.query<{ public_key: string; private_ciphertext: Buffer; private_iv: Buffer; key_version: number }>(
    'SELECT public_key, private_ciphertext, private_iv, key_version FROM app.notification_keys WHERE id = 1',
  );
  const row = rows[0]!;
  return { publicKey: row.public_key, privateKey: box.open({ ciphertext: row.private_ciphertext, iv: row.private_iv, keyVersion: row.key_version }) };
}

export interface Subscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type PushResult =
  | { kind: 'sent' }
  // 404/410: the browser dropped the subscription; 403: it was made with other keys. It never works again.
  | { kind: 'gone'; status: number }
  // The network, a time-out, 429 or 5xx: one more attempt later may work.
  | { kind: 'retry'; status: number | null; code: string }
  // Any other refusal (400, 413…): the same push never goes.
  | { kind: 'refused'; status: number };

// How a built request reaches the push service: https to a public address in an installation, a local fake in tests.
export type PushTransport = (endpoint: URL, headers: Record<string, string>, body: Buffer) => Promise<number>;

export const httpsTransport: PushTransport = (endpoint, headers, body) =>
  new Promise((resolve, reject) => {
    const req = https.request(endpoint, { method: 'POST', headers, lookup: publicLookup, signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });

// Push services listen on https at the standard port; anything else is not a push service.
export function checkEndpoint(raw: string, testOrigin: string | null): URL {
  const url = new URL(raw);
  if (testOrigin && url.origin === testOrigin) return url;
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) {
    throw appError('APP_PUSH_SUBSCRIBE_FAILED', `push endpoint ${url.protocol}//${url.host} is not a push service address`);
  }
  try {
    assertPublicLiteral(url.hostname);
  } catch (error) {
    throw appError('APP_PUSH_SUBSCRIBE_FAILED', `push endpoint ${url.host} is an inner address`, { cause: error });
  }
  return url;
}

export interface PushSender {
  send(subscription: Subscription, payload: PushPayload, options: { ttlSeconds: number; urgency: 'normal' | 'high' }): Promise<PushResult>;
}

export function createPushSender(deps: { keys: VapidKeys; subject: () => Promise<string>; transport: PushTransport; testOrigin: string | null }): PushSender {
  return {
    async send(subscription, payload, options) {
      const endpoint = checkEndpoint(subscription.endpoint, deps.testOrigin);
      const details = webpush.generateRequestDetails({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, JSON.stringify(payload), {
        vapidDetails: { subject: await deps.subject(), publicKey: deps.keys.publicKey, privateKey: deps.keys.privateKey },
        TTL: options.ttlSeconds,
        urgency: options.urgency,
        // A newer push with the same topic replaces one still waiting at the push service (up to 32 url-safe characters).
        topic: payload.id.replaceAll('-', ''),
      });
      let status: number;
      try {
        status = await deps.transport(endpoint, details.headers, details.body);
      } catch (error) {
        const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : error instanceof Error ? error.name : 'unknown';
        return { kind: 'retry', status: null, code };
      }
      if (status >= 200 && status < 300) return { kind: 'sent' };
      if (status === 404 || status === 410 || status === 403) return { kind: 'gone', status };
      if (status === 429 || status >= 500) return { kind: 'retry', status, code: `http_${status}` };
      return { kind: 'refused', status };
    },
  };
}

// The contact of the installation for the push services (VAPID `subject`): the earliest superadmin's address.
export async function vapidSubject(db: Db): Promise<string> {
  const { rows } = await db.query<{ email: string }>(
    `SELECT u."email" FROM app."user" u JOIN app.user_roles ur ON ur.user_id = u."id" JOIN app.roles r ON r.id = ur.role_id
      WHERE r.builtin = 'superadmin' ORDER BY u."createdAt", u."id" LIMIT 1`,
  );
  const email = rows[0]?.email;
  if (!email) throw appError('APP_PUSH_FAILED', 'no superadmin to name as the VAPID subject');
  return `mailto:${email}`;
}
