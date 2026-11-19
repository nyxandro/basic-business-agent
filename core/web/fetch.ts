// Opening a page or a document by its address (spec, section 8.30): the server downloads it — the gateway cannot
// — and reads its text the way an attachment is read (core/doctext, in the sandbox). Only public addresses are
// reached, checked on every connection and every redirect (core/net/public-address.ts); a page of the internal
// network, the gateway or the server itself is never opened. Nothing is written into the employee's folder.
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable } from 'node:stream';
import { appError } from '../errors/catalog.ts';
import type { DocTextService } from '../doctext/service.ts';
import { WEB_PAGE_EXTENSION } from '../doctext/extract.ts';
import { sliceWhole } from '../history/read.ts';
import { assertPublicLiteral, publicLookup } from '../net/public-address.ts';

export const FETCH_MAX_BYTES = 10 * 1024 * 1024;
export const FETCH_MAX_MS = 20_000;
const MAX_REDIRECTS = 5;
export const ADDRESS_MAX_CHARS = 2000;
// What the model gets of a page at a time, as of an attached document (F27); further with `offset`.
export const PAGE_SHOWN_CHARS = 20_000;
// A page with less text than this is a page built by scripts in a browser, not a page to read.
const MIN_PAGE_TEXT_CHARS = 200;
const PORTS: ReadonlySet<string> = new Set(['', '80', '443']);
const USER_AGENT = 'Mozilla/5.0 (compatible; BBA-Agent/1.0)';
const WORK_PREFIX = 'bba-web-';
// Statuses of a site that does not let a program in.
const BLOCKED_STATUSES: ReadonlySet<number> = new Set([401, 403, 429]);
// Pages of the protections against robots (measure M10a): a check instead of the page.
const BOT_CHECKS = [/ddos-guard/i, /qrator/i, /cf-chl|just a moment\.\.\.|attention required! \| cloudflare/i, /проверка браузера|вы не робот/i];

export type PageKind = 'html' | 'pdf' | 'word' | 'sheet' | 'slides' | 'text';

export interface FetchedPage {
  address: string;
  final_address: string;
  title: string;
  kind: PageKind;
  text: string;
  from: number;
  to: number;
  total_chars: number;
}

export interface PageReader {
  read(address: string, offset: number): Promise<FetchedPage>;
}

export interface PageReaderDeps {
  docText: Pick<DocTextService, 'text'>;
  // FETCH_MAX_MS in an installation; tests shorten it.
  timeoutMs: number;
  // Tests open a page of a local server: its host and port pass the checks, nothing else does.
  testSite?: { host: string; port: string };
}

// Media types and the extension the reader of documents knows them by.
const TYPES: [RegExp, string, PageKind][] = [
  [/^text\/html|^application\/xhtml\+xml/, '.html', 'html'],
  [/^application\/pdf/, '.pdf', 'pdf'],
  [/wordprocessingml/, '.docx', 'word'],
  [/^application\/msword/, '.doc', 'word'],
  [/^application\/rtf|^text\/rtf/, '.rtf', 'word'],
  [/opendocument\.text/, '.odt', 'word'],
  [/spreadsheetml/, '.xlsx', 'sheet'],
  [/^application\/vnd\.ms-excel/, '.xls', 'sheet'],
  [/opendocument\.spreadsheet/, '.ods', 'sheet'],
  [/^text\/csv/, '.csv', 'sheet'],
  [/presentationml/, '.pptx', 'slides'],
  [/^application\/vnd\.ms-powerpoint/, '.ppt', 'slides'],
  [/opendocument\.presentation/, '.odp', 'slides'],
  [/^text\/plain|^text\/markdown|^application\/json|^text\/xml|^application\/xml/, '.txt', 'text'],
];
const BY_EXTENSION: Record<string, [string, PageKind]> = Object.fromEntries(TYPES.map(([, ext, kind]) => [ext, [ext, kind]]));

function typeOf(contentType: string, address: URL, head: Buffer): [string, PageKind] | null {
  const media = contentType.split(';')[0]!.trim().toLowerCase();
  const known = TYPES.find(([re]) => re.test(media));
  if (known) return [known[1], known[2]];
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return ['.pdf', 'pdf'];
  // A server that says «application/octet-stream» about a document: the address names it.
  const ext = address.pathname.toLowerCase().match(/\.[a-z]{2,5}$/)?.[0];
  if (ext && BY_EXTENSION[ext]) return BY_EXTENSION[ext];
  if (/^\s*</.test(head.subarray(0, 512).toString('latin1'))) return ['.html', 'html'];
  return null;
}

function checkAddress(raw: string, testSite: PageReaderDeps['testSite']): URL {
  if (raw.length > ADDRESS_MAX_CHARS) throw appError('APP_WEB_FETCH_BAD_URL', `address of ${raw.length} chars`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw appError('APP_WEB_FETCH_BAD_URL', 'not an address', { cause: error });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw appError('APP_WEB_FETCH_BAD_URL', `scheme ${url.protocol}`);
  if (!url.hostname) throw appError('APP_WEB_FETCH_BAD_URL', 'no host');
  if (testSite && url.hostname === testSite.host && url.port === testSite.port) return url;
  if (!PORTS.has(url.port)) throw appError('APP_WEB_FETCH_BAD_URL', `port ${url.port}`);
  assertPublicLiteral(url.hostname);
  return url;
}

interface Downloaded {
  final: URL;
  status: number;
  contentType: string;
  body: Buffer;
}

function decoded(res: http.IncomingMessage): Readable {
  const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();
  if (encoding === 'gzip' || encoding === 'x-gzip') return res.pipe(createGunzip());
  if (encoding === 'br') return res.pipe(createBrotliDecompress());
  if (encoding === 'deflate') return res.pipe(createInflate());
  return res;
}

// One request, no redirect followed: the caller checks the next address first.
function request(url: URL, signal: AbortSignal, lookup: LookupFunction | undefined): Promise<http.IncomingMessage> {
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.get(
      url,
      { signal, ...(lookup ? { lookup } : {}), headers: { 'user-agent': USER_AGENT, 'accept-language': 'ru-RU,ru;q=0.9,en;q=0.5', 'accept-encoding': 'gzip, deflate, br', accept: '*/*' } },
      resolve,
    );
    req.on('error', reject);
  });
}

async function readLimited(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    bytes += chunk.length;
    if (bytes > FETCH_MAX_BYTES) {
      stream.destroy();
      throw appError('APP_WEB_FETCH_TOO_LARGE', `more than ${FETCH_MAX_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function download(start: URL, deps: PageReaderDeps): Promise<Downloaded> {
  const signal = AbortSignal.timeout(deps.timeoutMs);
  let url = start;
  try {
    for (let hop = 0; ; hop++) {
      const local = deps.testSite && url.hostname === deps.testSite.host && url.port === deps.testSite.port;
      const res = await request(url, signal, local ? undefined : publicLookup);
      const location = res.headers.location;
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && location) {
        res.resume();
        if (hop >= MAX_REDIRECTS) throw appError('APP_WEB_FETCH_HTTP', `more than ${MAX_REDIRECTS} redirects`);
        url = checkAddress(new URL(location, url).toString(), deps.testSite);
        continue;
      }
      const body = await readLimited(decoded(res));
      return { final: url, status: res.statusCode ?? 0, contentType: String(res.headers['content-type'] ?? ''), body };
    }
  } catch (error) {
    if (signal.aborted) throw appError('APP_WEB_FETCH_TIMEOUT', `no answer in ${deps.timeoutMs} ms`, { cause: error });
    if ((error as { code?: string }).code?.startsWith('APP_')) throw error;
    throw appError('APP_WEB_FETCH_HTTP', `the site did not answer: ${(error as { code?: string }).code ?? (error instanceof Error ? error.name : 'unknown')}`, { cause: error });
  }
}

// The charset of the page: the header's, else the page's own <meta>, else UTF-8.
function charsetOf(contentType: string, head: string): string {
  const header = contentType.match(/charset=["']?([\w-]+)/i)?.[1];
  const meta = head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1];
  return (header ?? meta ?? 'utf-8').toLowerCase();
}

function textOfBody(body: Buffer, contentType: string): string {
  const charset = charsetOf(contentType, body.subarray(0, 4096).toString('latin1'));
  try {
    return new TextDecoder(charset).decode(body);
  } catch (error) {
    // A charset Node does not know: the bytes are read as UTF-8 — readable for most pages, never dropped.
    if (error instanceof RangeError) return new TextDecoder('utf-8').decode(body);
    throw error;
  }
}

const decodeEntities = (s: string) =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');

export function createPageReader(deps: PageReaderDeps): PageReader {
  return {
    async read(address, offset) {
      const start = checkAddress(address, deps.testSite);
      const got = await download(start, deps);
      if (BLOCKED_STATUSES.has(got.status)) throw appError('APP_WEB_FETCH_BLOCKED_BY_SITE', `status ${got.status}`, { details: { status: got.status } });
      if (got.status >= 400) throw appError('APP_WEB_FETCH_HTTP', `status ${got.status}`, { details: { status: got.status } });
      const type = typeOf(got.contentType, got.final, got.body);
      if (!type) throw appError('APP_WEB_FETCH_UNSUPPORTED', `type ${got.contentType || 'unknown'}`);
      const [ext, kind] = type;
      let bytes = got.body;
      let title = decodeURIComponent(got.final.pathname.split('/').filter(Boolean).at(-1) ?? got.final.hostname);
      if (kind === 'html' || kind === 'text') {
        // Read in its own charset, written in UTF-8: the reader of documents then needs no guess.
        let text = textOfBody(got.body, got.contentType);
        if (kind === 'html') {
          if (BOT_CHECKS.some((re) => re.test(text.slice(0, 20_000)))) throw appError('APP_WEB_FETCH_BLOCKED_BY_SITE', 'a check against robots');
          title = decodeEntities(text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? title);
          text = `<meta charset="utf-8">${text.replace(/<meta[^>]+charset=[^>]*>/gi, '')}`;
        }
        bytes = Buffer.from(text, 'utf8');
      }
      const work = mkdtempSync(join(tmpdir(), WORK_PREFIX));
      // A page of HTML is read for its main text (core/doctext/extract.ts, WEB_PAGE_EXTENSION).
      const name = kind === 'html' ? `page${WEB_PAGE_EXTENSION}` : `page${ext}`;
      try {
        writeFileSync(join(work, name), bytes);
        const doc = await deps.docText.text(work, name);
        if (!doc) throw appError('APP_WEB_FETCH_UNSUPPORTED', `no reader for ${ext}`);
        if (doc.state === 'password') throw appError('APP_WEB_FETCH_UNSUPPORTED', 'a document with a password');
        if (doc.state === 'scan') throw appError('APP_WEB_FETCH_NO_TEXT', 'a scan without text');
        if (doc.state !== 'ok') throw appError('APP_WEB_FETCH_UNSUPPORTED', `the document was not read: ${doc.state}`);
        if (kind === 'html' && doc.chars < MIN_PAGE_TEXT_CHARS) throw appError('APP_WEB_FETCH_NO_TEXT', `${doc.chars} chars of text`);
        const shown = sliceWhole(doc.text, offset, offset + PAGE_SHOWN_CHARS);
        const to = offset + shown.length;
        // The reader keeps the beginning of a long document only (DOC_TEXT_KEPT_CHARS): further it says so.
        const tail =
          to >= doc.chars ? '' : to < doc.text.length ? `\n\nПоказаны знаки ${offset + 1}–${to} из ${doc.chars}; дальше — web_fetch с offset: ${to}.` : `\n\nДальше ${doc.text.length} знаков текст этой страницы не читается.`;
        return { address, final_address: got.final.toString(), title, kind, text: `${shown}${tail}`, from: offset, to, total_chars: doc.chars };
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  };
}

// The model's text of a failure of opening a page: what happened and what it can do instead.
export function fetchFailureMessage(code: string, details?: Record<string, unknown>): string {
  switch (code) {
    case 'APP_WEB_FETCH_BAD_URL':
      return 'Это не адрес страницы: нужен адрес до 2 000 знаков, который начинается с http:// или https://, без нестандартного порта.';
    case 'APP_WEB_FETCH_BLOCKED_ADDRESS':
      return 'Это внутренний адрес: такие страницы не открываются.';
    case 'APP_WEB_FETCH_BLOCKED_BY_SITE':
      return 'Сайт не пустил: он требует входа или закрыт от программ. Возьми другой источник.';
    case 'APP_WEB_FETCH_HTTP':
      return `Сайт ответил ошибкой${typeof details?.status === 'number' ? ` ${details.status}` : ''}: 404 — такой страницы нет, 5xx — сбой на сайте; без кода — сайт не ответил.`;
    case 'APP_WEB_FETCH_TIMEOUT':
      return 'Сайт не ответил за 20 секунд.';
    case 'APP_WEB_FETCH_TOO_LARGE':
      return 'Файл по ссылке больше 10 МБ — такой не скачивается.';
    case 'APP_WEB_FETCH_UNSUPPORTED':
      return 'По ссылке не страница и не документ (картинка, видео, архив или файл с паролем) — прочитать его нельзя.';
    case 'APP_WEB_FETCH_NO_TEXT':
      return 'На странице нет текста: похоже, сайт строит её скриптами в браузере. Возьми другой источник.';
    default:
      return 'Страница не открылась.';
  }
}

// At the start of the server: folders a stopped read left behind.
export function cleanWebWork(workRoot: string): void {
  for (const name of readdirSync(workRoot)) if (name.startsWith(WORK_PREFIX)) rmSync(join(workRoot, name), { recursive: true, force: true });
}
