// Test helper: a push service on a local port. Each subscription it hands out has its own browser keys, and every push
// it receives is decrypted here by RFC 8291 / RFC 8188 (aes128gcm) with node:crypto — independently of `web-push`, so
// a test proves the push is readable by a real browser, not merely that the library agrees with itself.
import { createDecipheriv, createECDH, hkdfSync, randomBytes, randomUUID, type ECDH } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PushPayload } from '@bba/contracts';
import type { PushTransport } from './push.ts';

export interface ReceivedPush {
  endpoint: string;
  payload: PushPayload;
  ttl: number;
  urgency: string | undefined;
  topic: string | undefined;
  authorization: string;
}

export interface FakeSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface FakePushService {
  origin: string;
  // How the server reaches this service in tests (plain http on 127.0.0.1).
  transport: PushTransport;
  subscribe(): FakeSubscription;
  received: ReceivedPush[];
  // The next answers to an endpoint, then 201 again (e.g. [503] once, or [410]).
  answer(endpoint: string, statuses: number[]): void;
  close(): Promise<void>;
}

interface Browser {
  ecdh: ECDH;
  auth: Buffer;
}

function decrypt(body: Buffer, browser: Browser): string {
  const salt = body.subarray(0, 16);
  const idLength = body.readUInt8(20);
  const senderPublic = body.subarray(21, 21 + idLength);
  const record = body.subarray(21 + idLength);
  const shared = browser.ecdh.computeSecret(senderPublic);
  const receiverPublic = browser.ecdh.getPublicKey();
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), receiverPublic, senderPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, browser.auth, keyInfo, 32));
  const key = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', key, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  // The last record ends with 0x02 and zero padding after it.
  let end = padded.length - 1;
  while (end > 0 && padded[end] === 0) end--;
  if (padded[end] !== 2) throw new Error('push record does not end with the last-record delimiter');
  return padded.subarray(0, end).toString('utf8');
}

// `port` — a fixed one for the browser stand, whose scenarios read GET /received (what the «phones» got).
export async function startFakePushService(opts: { port?: number } = {}): Promise<FakePushService> {
  const browsers = new Map<string, Browser>();
  const scripted = new Map<string, number[]>();
  const received: ReceivedPush[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/received') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(received));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const endpoint = `${origin}${req.url ?? ''}`;
      const browser = browsers.get(endpoint);
      const status = scripted.get(endpoint)?.shift() ?? (browser ? 201 : 404);
      if (status === 201 && browser) {
        received.push({
          endpoint,
          payload: JSON.parse(decrypt(Buffer.concat(chunks), browser)) as PushPayload,
          ttl: Number(req.headers.ttl),
          urgency: req.headers.urgency as string | undefined,
          topic: req.headers.topic as string | undefined,
          authorization: req.headers.authorization ?? '',
        });
      }
      res.statusCode = status;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const transport: PushTransport = (endpoint, headers, body) =>
    new Promise((resolve, reject) => {
      const req = http.request(endpoint, { method: 'POST', headers }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end(body);
    });

  return {
    origin,
    transport,
    received,
    subscribe() {
      const ecdh = createECDH('prime256v1');
      ecdh.generateKeys();
      const auth = randomBytes(16);
      const endpoint = `${origin}/push/${randomUUID()}`;
      browsers.set(endpoint, { ecdh, auth });
      return { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
    },
    answer(endpoint, statuses) {
      scripted.set(endpoint, [...statuses]);
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
