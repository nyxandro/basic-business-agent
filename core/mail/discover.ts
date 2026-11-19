// Settings of a mailbox found by its address alone (spec, section 8.24), the way mail programs do it, without
// asking any third party: a popular service by the domain, then by the domain's mail exchanger (Yandex 360,
// Google Workspace, Microsoft 365, VK WorkSpace keep company domains), then the settings the domain
// publishes itself (autoconfig of Thunderbird, SRV records of RFC 6186), then a server that answers at a
// usual name. Nothing found — the person enters the servers by hand.
import { lookup, resolveMx, resolveSrv } from 'node:dns/promises';
import { isPublicAddress } from '../net/public-address.ts';
import { Socket } from 'node:net';
import { MAIL_PRESETS, OTHER_MAIL_PASSWORD_HELP, type MailDiscovery, type MailOAuthProvider, type MailPreset, type MailSecurity, type MailServer, type MailServers } from '@bba/contracts';

const DOMAINS: Record<string, string> = Object.fromEntries(
  Object.entries({
    yandex: ['yandex.ru', 'ya.ru', 'yandex.com', 'yandex.by', 'yandex.kz', 'yandex.ua', 'narod.ru'],
    mailru: ['mail.ru', 'inbox.ru', 'list.ru', 'bk.ru', 'internet.ru', 'xmail.ru'],
    google: ['gmail.com', 'googlemail.com'],
    microsoft: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'outlook.ru', 'hotmail.ru'],
    icloud: ['icloud.com', 'me.com', 'mac.com'],
    rambler: ['rambler.ru', 'lenta.ru', 'autorambler.ru', 'myrambler.ru', 'ro.ru', 'rambler.ua'],
    yahoo: ['yahoo.com', 'ymail.com', 'rocketmail.com'],
  }).flatMap(([preset, domains]) => domains.map((d) => [d, preset])),
);

// Mail exchangers of the services that keep company domains: the ending of the MX host → the preset.
const MX_ENDINGS: [ending: string, preset: string][] = [
  ['.yandex.net', 'yandex'],
  ['.yandex.ru', 'yandex'],
  ['.google.com', 'google'],
  ['.googlemail.com', 'google'],
  ['.mail.protection.outlook.com', 'microsoft'],
  ['.outlook.com', 'microsoft'],
  ['.mail.ru', 'mailru'],
  ['.icloud.com', 'icloud'],
  ['.rambler.ru', 'rambler'],
  ['.yahoodns.net', 'yahoo'],
];

export interface DiscoverDeps {
  resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]>;
  resolveSrv(name: string): Promise<{ name: string; port: number; priority: number }[]>;
  // The autoconfig file of the domain: its text, or null when there is none.
  fetchConfig(url: string): Promise<string | null>;
  // A mail server answers on this port.
  answers(host: string, port: number): Promise<boolean>;
}

const LOOKUP_MS = 4000;
const CONFIG_MAX_BYTES = 64 * 1024;

// A host the server may reach while guessing: every address of it is public (core/net/public-address.ts) — the
// published settings of a domain are not read from inside.
async function publicHost(host: string): Promise<string | null> {
  const addresses = await lookup(host, { all: true }).catch(() => []);
  if (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a.address))) return null;
  return addresses[0]!.address;
}

// The body up to the limit, read as it comes: a huge answer is not taken into memory.
async function limitedText(res: Response): Promise<string | null> {
  if (!res.body) return null;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    bytes += chunk.byteLength;
    if (bytes > CONFIG_MAX_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// What the server finds by guessing goes only to public addresses: the person's domain must not lead the
// server into its own network. A server the person types by hand may be inside it (mail of the company's
// own server) — only its mail ports are reachable then (IMAP_PORTS, SMTP_PORTS).
export const realDiscoverDeps: DiscoverDeps = {
  resolveMx: (domain) => resolveMx(domain),
  resolveSrv: async (name) => {
    const records = await resolveSrv(name);
    const open = await Promise.all(records.map(async (r) => ((await publicHost(r.name)) ? r : null)));
    return open.filter((r): r is NonNullable<typeof r> => r !== null);
  },
  async fetchConfig(url) {
    const address = await publicHost(new URL(url).hostname);
    if (!address) return null;
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(LOOKUP_MS) }).catch(() => null);
    if (!res?.ok) return null;
    return limitedText(res).catch(() => null);
  },
  async answers(host, port) {
    const address = await publicHost(host);
    if (!address) return false;
    return new Promise((resolve) => {
      const socket = new Socket();
      const done = (ok: boolean) => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(LOOKUP_MS, () => done(false));
      socket.once('error', () => done(false));
      // To the address checked, not the name again: the name cannot turn private in between.
      socket.connect(port, address, () => done(true));
    });
  },
};

const presetById = (id: string): MailPreset | undefined => MAIL_PRESETS.find((p) => p.id === id);

function fromPreset(email: string, preset: MailPreset, source: 'preset' | 'mx', oauthReady: ReadonlySet<MailOAuthProvider>): MailDiscovery {
  return { email, source, provider: preset.id, title: preset.title, servers: preset.servers, oauth: preset.oauth && oauthReady.has(preset.oauth) ? preset.oauth : null, password: preset.password };
}

function found(email: string, source: MailDiscovery['source'], servers: MailServers, title: string): MailDiscovery {
  return { email, source, provider: 'custom', title, servers, oauth: null, password: { help: OTHER_MAIL_PASSWORD_HELP, url: null } };
}

const SOCKETS: Record<string, MailSecurity> = { SSL: 'tls', STARTTLS: 'starttls' };

// The first IMAP and SMTP servers of an autoconfig file that are protected (plain text is not taken).
export function parseAutoconfig(xml: string, domain: string): MailServers | null {
  const servers = (tag: string, type: string): MailServer | null => {
    for (const block of xml.matchAll(new RegExp(`<${tag}[^>]*type="${type}"[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'))) {
      const body = block[1]!;
      const host = /<hostname>\s*([^<\s]+)\s*<\/hostname>/i.exec(body)?.[1]?.replace('%EMAILDOMAIN%', domain);
      const port = Number(/<port>\s*(\d+)\s*<\/port>/i.exec(body)?.[1]);
      const security = SOCKETS[/<socketType>\s*([A-Za-z]+)\s*<\/socketType>/i.exec(body)?.[1]?.toUpperCase() ?? ''];
      if (host && /^[A-Za-z0-9.-]+$/.test(host) && port && security) return { host, port, security };
    }
    return null;
  };
  const imap = servers('incomingServer', 'imap');
  const smtp = servers('outgoingServer', 'smtp');
  return imap && smtp ? { imap, smtp } : null;
}

async function bySrv(deps: DiscoverDeps, domain: string): Promise<MailServers | null> {
  const first = async (names: [string, MailSecurity][]): Promise<MailServer | null> => {
    for (const [name, security] of names) {
      const records = await deps.resolveSrv(`${name}.${domain}`).catch(() => []);
      const best = records.filter((r) => r.name && r.name !== '.').sort((a, b) => a.priority - b.priority)[0];
      if (best) return { host: best.name.replace(/\.$/, ''), port: best.port, security };
    }
    return null;
  };
  const imap = await first([
    ['_imaps._tcp', 'tls'],
    ['_imap._tcp', 'starttls'],
  ]);
  const smtp = await first([
    ['_submissions._tcp', 'tls'],
    ['_submission._tcp', 'starttls'],
  ]);
  return imap && smtp ? { imap, smtp } : null;
}

// The domain a mail exchanger belongs to: mx1.beget.com → beget.com.
const ownerOf = (host: string) => host.replace(/\.$/, '').split('.').slice(-2).join('.');

async function byGuess(deps: DiscoverDeps, domain: string, mxDomain: string | null): Promise<MailServers | null> {
  const bases = [...new Set([mxDomain, domain].filter((d): d is string => !!d))];
  const pick = async (names: string[], ports: [number, MailSecurity][]): Promise<MailServer | null> => {
    for (const host of names) for (const [port, security] of ports) if (await deps.answers(host, port)) return { host, port, security };
    return null;
  };
  const imap = await pick([...bases.map((b) => `imap.${b}`), `mail.${domain}`], [[993, 'tls']]);
  if (!imap) return null;
  const smtp = await pick(
    [...bases.map((b) => `smtp.${b}`), `mail.${domain}`],
    [
      [465, 'tls'],
      [587, 'starttls'],
    ],
  );
  return smtp ? { imap, smtp } : null;
}

export async function discoverMail(deps: DiscoverDeps, email: string, oauthReady: ReadonlySet<MailOAuthProvider>): Promise<MailDiscovery> {
  const domain = email.split('@').pop()!.toLowerCase();
  const known = presetById(DOMAINS[domain] ?? '');
  if (known) return fromPreset(email, known, 'preset', oauthReady);
  const mx = (await deps.resolveMx(domain).catch(() => [])).sort((a, b) => a.priority - b.priority);
  for (const record of mx) {
    const host = `.${record.exchange.toLowerCase().replace(/\.$/, '')}`;
    const match = MX_ENDINGS.find(([ending]) => host.endsWith(ending));
    const preset = match ? presetById(match[1]) : undefined;
    if (preset) return fromPreset(email, preset, 'mx', oauthReady);
  }
  for (const url of [`https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(email)}`, `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml`]) {
    const xml = await deps.fetchConfig(url).catch(() => null);
    const servers = xml ? parseAutoconfig(xml, domain) : null;
    if (servers) return found(email, 'autoconfig', servers, domain);
  }
  const srv = await bySrv(deps, domain);
  if (srv) return found(email, 'srv', srv, domain);
  const guessed = await byGuess(deps, domain, mx[0] ? ownerOf(mx[0].exchange) : null);
  if (guessed) return found(email, 'guess', guessed, domain);
  return { email, source: 'none', provider: 'custom', title: domain, servers: null, oauth: null, password: { help: OTHER_MAIL_PASSWORD_HELP, url: null } };
}
