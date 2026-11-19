// Addresses the server may reach on someone's behalf — a page the agent opens (spec, section 8.30), the settings
// a mail domain publishes (8.24): only public ones. Loopback, private networks, link-local (cloud metadata),
// carrier-grade NAT, benchmarking, multicast and reserved ranges are refused, IPv4 written inside IPv6 too.
// The check sits on the connection itself (`lookup` of node:http and node:https): a name cannot turn to an inner
// address between a check and the connection.
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { appError } from '../errors/catalog.ts';

const INNER = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  INNER.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  INNER.addSubnet(network, prefix, 'ipv6');
}

// «::ffff:10.0.0.5» and «::ffff:a00:5» are 10.0.0.5: the IPv4 inside is what the connection reaches.
function ipv4Inside(address: string): string | null {
  const lower = address.toLowerCase();
  if (!lower.startsWith('::ffff:')) return null;
  const rest = lower.slice('::ffff:'.length);
  if (isIP(rest) === 4) return rest;
  const groups = rest.split(':');
  if (groups.length !== 2 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  const [hi, lo] = groups.map((g) => parseInt(g, 16)) as [number, number];
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 4) return !INNER.check(address, 'ipv4');
  const inside = ipv4Inside(address);
  if (inside) return isPublicAddress(inside);
  return !INNER.check(address, 'ipv6');
}

// A host written as an address («10.0.0.5», «[::1]»): `lookup` is not called for it, so it is checked here.
export function assertPublicLiteral(hostname: string): void {
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (isIP(host) !== 0 && !isPublicAddress(host)) throw appError('APP_WEB_FETCH_BLOCKED_ADDRESS', `inner address ${host}`);
}

// `lookup` for node:http and node:https: every address of the name must be public, else the connection fails.
export const publicLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '', 0);
    const all: LookupAddress[] = addresses;
    if (all.length === 0) return callback(Object.assign(new Error(`no address for ${hostname}`), { code: 'ENOTFOUND' }), '', 0);
    if (all.some((a) => !isPublicAddress(a.address))) return callback(appError('APP_WEB_FETCH_BLOCKED_ADDRESS', `${hostname} resolves to an inner address`), '', 0);
    if (options.all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, all);
    return callback(null, all[0]!.address, all[0]!.family);
  });
};
