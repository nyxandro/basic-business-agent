// How the app talks to the container of program servers, mcp-runner (docs/specs/[20.11.2026]-mcp-connections.md, F1,
// step 9). The runner keeps no database and no secrets of its own: every request names the program and carries the
// values of the shared key, signed with the secret of the installation — nobody else in its network can start a
// program or change one, and an old request cannot be sent again later.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const programSpecSchema = z.object({
  runner: z.enum(['npx', 'uvx']),
  package: z.string().min(1).max(200),
  args: z.array(z.string().max(500)).max(30),
  // The only environment the program gets: the admin's templates filled with the shared key.
  env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/), z.string().max(4000)),
});
export type ProgramSpec = z.infer<typeof programSpecSchema>;

export const RUNNER_HEADERS = { spec: 'x-bba-program', time: 'x-bba-time', signature: 'x-bba-signature' } as const;
const SIGNATURE_TTL_MS = 5 * 60 * 1000;

export const runnerPath = (serverId: string, what: 'mcp' | 'prepare') => `/servers/${serverId}/${what}`;

const mac = (secret: string, serverId: string, time: string, spec: string) => createHmac('sha256', secret).update(`${serverId}\n${time}\n${spec}`).digest('base64url');

export function signedHeaders(secret: string, serverId: string, spec: ProgramSpec, now = Date.now()): Record<string, string> {
  const encoded = Buffer.from(JSON.stringify(spec)).toString('base64url');
  const time = String(now);
  return { [RUNNER_HEADERS.spec]: encoded, [RUNNER_HEADERS.time]: time, [RUNNER_HEADERS.signature]: mac(secret, serverId, time, encoded) };
}

// The program of a signed request; any doubt — a missing header, another server, an old time, a wrong signature — throws.
export function verifiedSpec(secret: string, serverId: string, header: (name: string) => string | undefined, now = Date.now()): ProgramSpec {
  const encoded = header(RUNNER_HEADERS.spec);
  const time = header(RUNNER_HEADERS.time);
  const signature = header(RUNNER_HEADERS.signature);
  if (!encoded || !time || !signature) throw new Error('unsigned request');
  if (!/^\d+$/.test(time) || Math.abs(now - Number(time)) > SIGNATURE_TTL_MS) throw new Error('stale signature');
  const expected = Buffer.from(mac(secret, serverId, time, encoded));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new Error('bad signature');
  return programSpecSchema.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')));
}

// One process per server and program: a new package, arguments or key start a new one.
export const programKey = (serverId: string, spec: ProgramSpec) => createHash('sha256').update(`${serverId}\n${JSON.stringify(spec)}`).digest('hex').slice(0, 24);
