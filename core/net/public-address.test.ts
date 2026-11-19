// Addresses the server may reach on someone's behalf (spec, section 8.30): only public ones, IPv4 written inside
// IPv6 included; the check sits on the connection (`publicLookup`).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { assertPublicLiteral, isPublicAddress, publicLookup } from './public-address.ts';

const INNER_EXAMPLES = [
  '0.0.0.0',
  '10.0.0.5',
  '100.64.1.1',
  '127.0.0.1',
  '169.254.169.254',
  '172.16.0.1',
  '172.31.255.255',
  '192.0.0.8',
  '192.168.1.1',
  '198.18.0.1',
  '224.0.0.1',
  '255.255.255.255',
  '::',
  '::1',
  'fd12:3456::1',
  'fe80::1',
  'ff02::1',
  '::ffff:127.0.0.1',
  '::ffff:a00:5',
  '64:ff9b::a9fe:a9fe',
  '2002:a9fe:a9fe::1',
  'fec0::1',
  '::127.0.0.1',
];
const PUBLIC_EXAMPLES = ['8.8.8.8', '77.88.55.88', '172.32.0.1', '192.169.0.1', '2a00:1450:4001::1', '::ffff:8.8.8.8'];

// The inner IPv4 ranges as [first octets, prefix]: a generated address inside one of them.
const INNER_V4: [number[], number][] = [
  [[0], 8],
  [[10], 8],
  [[100, 64], 10],
  [[127], 8],
  [[169, 254], 16],
  [[172, 16], 12],
  [[192, 0, 0], 24],
  [[192, 168], 16],
  [[198, 18], 15],
  [[224], 4],
  [[240], 4],
];

function insideV4(range: [number[], number], random: number): string {
  const [start, prefix] = range;
  const base = [...start, 0, 0, 0, 0].slice(0, 4).reduce((n, o) => n * 256 + o, 0);
  const host = random % 2 ** (32 - prefix);
  const value = base + host;
  return [24, 16, 8, 0].map((s) => (value >>> s) & 255).join('.');
}

describe('public addresses', () => {
  it('refuses every inner range and lets public ones through', () => {
    for (const a of INNER_EXAMPLES) expect(isPublicAddress(a), a).toBe(false);
    for (const a of PUBLIC_EXAMPLES) expect(isPublicAddress(a), a).toBe(true);
    expect(isPublicAddress('example.com')).toBe(false);
  });

  // Property: any address inside an inner IPv4 range is refused, and so is the same address written in IPv6.
  it('refuses any address of an inner range, written in IPv4 or inside IPv6', () => {
    fc.assert(
      fc.property(fc.constantFrom(...INNER_V4), fc.nat(), (range, random) => {
        const v4 = insideV4(range, random);
        const [a, b, c, d] = v4.split('.').map(Number) as [number, number, number, number];
        const hex = `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
        return !isPublicAddress(v4) && !isPublicAddress(`::ffff:${v4}`) && !isPublicAddress(`::ffff:${hex}`);
      }),
    );
  });

  it('checks a host written as an address, which never reaches `lookup`', () => {
    expect(() => assertPublicLiteral('10.0.0.5')).toThrow(expect.objectContaining({ code: 'APP_WEB_FETCH_BLOCKED_ADDRESS' }));
    expect(() => assertPublicLiteral('[::1]')).toThrow(expect.objectContaining({ code: 'APP_WEB_FETCH_BLOCKED_ADDRESS' }));
    expect(() => assertPublicLiteral('8.8.8.8')).not.toThrow();
    expect(() => assertPublicLiteral('example.com')).not.toThrow();
  });

  it('fails the connection to a name that resolves to an inner address', async () => {
    const error = await new Promise<unknown>((resolve) => publicLookup('localhost', {}, (e) => resolve(e)));
    expect(error).toMatchObject({ code: 'APP_WEB_FETCH_BLOCKED_ADDRESS' });
  });
});
