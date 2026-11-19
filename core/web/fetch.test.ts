// Opening a page (spec, section 8.30): only public addresses, on every connection and redirect; the text read in
// the sandbox the way an attachment is; the limits of size and time; the failures with their codes. A local site
// stands for the internet: its host and port alone pass the checks (`testSite`).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPreviewCache } from '../preview/cache.ts';
import { sandboxRunner } from '../preview/convert.ts';
import { createDocTextService, DOC_TEXT_CACHE_MAX_AGE_MS, DOC_TEXT_CACHE_MAX_BYTES, DOC_TEXT_CACHE_SUFFIX } from '../doctext/service.ts';
import { PREVIEW_MAX_UNPACKED_BYTES } from '../preview/service.ts';
import { createLimiter } from '../sandbox/limiter.ts';
import { assertIsolationAvailable } from '../sandbox/workspace.ts';
import { SYSTEM_SKILLS_DIR } from '../skills-admin/system.ts';
import { createPageReader, FETCH_MAX_BYTES, PAGE_SHOWN_CHARS, type PageReader } from './fetch.ts';

const VENV = fileURLToPath(new URL('../../.venv-skills', import.meta.url));
const PDF = readFileSync(fileURLToPath(new URL('../doctext/fixtures/mixed.pdf', import.meta.url)));
const TIMEOUT_MS = 1500;

// Windows-1251 of Russian text: what many Russian sites still send.
function cp1251(text: string): Buffer {
  return Buffer.from(
    [...text].map((ch) => {
      const code = ch.charCodeAt(0);
      if (code < 128) return code;
      if (code >= 0x410 && code <= 0x44f) return code - 0x410 + 0xc0;
      if (ch === 'Ё') return 0xa8;
      if (ch === 'ё') return 0xb8;
      return 0x3f;
    }),
  );
}

const article = (title: string, body: string) => `<html><head><title>${title}</title></head><body><nav>Меню</nav><article><h1>${title}</h1><p>${body}</p></article></body></html>`;
const LONG = Array.from({ length: 500 }, (_, i) => `<p>Абзац ${i + 1}: профнастил С21 оцинкованный, цена за лист и доставка по Екатеринбургу — подробности в прайсе.</p>`).join('\n');

let server: http.Server;
let base: string;
let reader: PageReader;
let work: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const send = (status: number, type: string, body: string | Buffer) => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };
    switch (req.url) {
      case '/page':
        return send(200, 'text/html; charset=utf-8', article('Профнастил С21 — цены', 'Профнастил С21 стоит 520 ₽ за лист. Доставка по Екатеринбургу — бесплатно от 50 листов. '.repeat(5)));
      case '/cp1251':
        return send(200, 'text/html; charset=windows-1251', cp1251(article('Цены на кровлю', 'Металлочерепица Монтеррей — 610 рублей за квадратный метр, ёмкость склада большая. '.repeat(5))));
      case '/long':
        return send(200, 'text/html; charset=utf-8', `<html><head><title>Прайс</title></head><body>${LONG}</body></html>`);
      case '/doc.pdf':
        return send(200, 'application/pdf', PDF);
      case '/missing':
        return send(404, 'text/html', 'нет');
      case '/forbidden':
        return send(403, 'text/html', 'нельзя');
      case '/ddos':
        return send(200, 'text/html', '<html><head><title>DDoS-Guard</title></head><body>Checking your browser before accessing the website. DDoS-Guard</body></html>');
      case '/slow':
        return; // never answers
      case '/huge':
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(Buffer.alloc(FETCH_MAX_BYTES + 1024 * 1024, 'a'));
        return;
      case '/picture.png':
        return send(200, 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      case '/empty':
        return send(200, 'text/html', '<html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
      case '/to-local':
        res.writeHead(302, { location: 'http://localhost/' });
        return res.end();
      case '/to-page':
        res.writeHead(301, { location: '/page' });
        return res.end();
      case '/gzip':
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' });
        return res.end(gzipSync(article('Сжатая страница', 'Металлочерепица — 610 ₽ за квадратный метр. '.repeat(10))));
      case '/gzip-silent': {
        // Headers and the first bytes of a compressed body, then silence.
        res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
        res.write(gzipSync(article('x', 'y'.repeat(500))).subarray(0, 20));
        return;
      }
      case '/gzip-cut': {
        res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
        res.write(gzipSync(article('x', 'y'.repeat(500))).subarray(0, 20));
        setTimeout(() => res.socket?.destroy(), 50);
        return;
      }
      case '/meta-trap':
        return send(200, 'text/html', `<html><head>${'<meta '.repeat(200_000)}</head><body>${'<p>Текст страницы, его достаточно для чтения.</p>'.repeat(20)}</body></html>`);
      case '/title-trap':
        return send(200, 'text/html', `<html><head><title>${'а'.repeat(1_000_000)}<p>Текст страницы, его достаточно для чтения.</p></body></html>`);
      case '/%EF%F0%E0%E9%F1.pdf':
        return send(200, 'application/pdf', PDF);
      default:
        return send(404, 'text/plain', 'нет');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = String((server.address() as AddressInfo).port);
  base = `http://127.0.0.1:${port}`;
  work = mkdtempSync(join(tmpdir(), 'bba-test-web-'));
  const docText = createDocTextService({
    run: sandboxRunner({ venv: VENV, isolation: assertIsolationAvailable(), readOnlyPaths: [join(SYSTEM_SKILLS_DIR, 'pptx', 'scripts')] }),
    officeLimiter: createLimiter(2, 60_000),
    commandLimiter: createLimiter(4, 60_000),
    cache: createPreviewCache({ dir: join(work, 'texts'), suffix: DOC_TEXT_CACHE_SUFFIX, maxBytes: DOC_TEXT_CACHE_MAX_BYTES, maxAgeMs: DOC_TEXT_CACHE_MAX_AGE_MS }),
    workRoot: work,
    pptxScripts: join(SYSTEM_SKILLS_DIR, 'pptx', 'scripts'),
    timezone: 'Europe/Moscow',
    maxUnpackedBytes: PREVIEW_MAX_UNPACKED_BYTES,
  });
  reader = createPageReader({ docText, timeoutMs: TIMEOUT_MS, testSite: { host: '127.0.0.1', port } });
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(work, { recursive: true, force: true });
});

const codeOf = (address: string) => reader.read(address, 0).then(
  () => 'opened',
  (error: { code?: string }) => error.code,
);

describe('opening a page', () => {
  it('reads a page and a page in windows-1251, with their titles, following a redirect', async () => {
    const page = await reader.read(`${base}/to-page`, 0);
    expect(page).toMatchObject({ kind: 'html', title: 'Профнастил С21 — цены', final_address: `${base}/page`, from: 0 });
    expect(page.text).toContain('520 ₽ за лист');
    const old = await reader.read(`${base}/cp1251`, 0);
    expect(old.title).toBe('Цены на кровлю');
    expect(old.text).toContain('610 рублей за квадратный метр, ёмкость склада');
  }, 60_000);

  it('reads a PDF by its address, with its pages', async () => {
    const pdf = await reader.read(`${base}/doc.pdf`, 0);
    expect(pdf.kind).toBe('pdf');
    expect(pdf.text).toContain('— стр. 1 —');
  }, 60_000);

  it('gives a long page in parts: the next part by the offset the first one names', async () => {
    const first = await reader.read(`${base}/long`, 0);
    expect(first.to).toBeLessThanOrEqual(PAGE_SHOWN_CHARS);
    expect(first.total_chars).toBeGreaterThan(PAGE_SHOWN_CHARS);
    expect(first.text).toContain(`дальше — web_fetch с offset: ${first.to}`);
    const second = await reader.read(`${base}/long`, first.to);
    expect(second.from).toBe(first.to);
    expect(second.text.startsWith(first.text.slice(0, 50))).toBe(false);
  }, 60_000);

  it('never connects to an inner address, written as one, by a name or through a redirect', async () => {
    for (const address of ['http://127.0.0.1/', 'http://10.0.0.5/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/latest/meta-data/', 'http://localhost/', `${base}/to-local`]) {
      expect(await codeOf(address), address).toBe('APP_WEB_FETCH_BLOCKED_ADDRESS');
    }
    expect(await codeOf('http://127.0.0.1:3000/')).toBe('APP_WEB_FETCH_BAD_URL');
    expect(await codeOf('ftp://example.com/file')).toBe('APP_WEB_FETCH_BAD_URL');
    expect(await codeOf(`https://example.com/${'a'.repeat(2001)}`)).toBe('APP_WEB_FETCH_BAD_URL');
  });

  it('reads a compressed page, and never hangs on a compressed body that goes silent or breaks', async () => {
    expect((await reader.read(`${base}/gzip`, 0)).text).toContain('610 ₽ за квадратный метр');
    const started = Date.now();
    expect(await codeOf(`${base}/gzip-silent`)).toBe('APP_WEB_FETCH_TIMEOUT');
    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS + 1000);
    expect(await codeOf(`${base}/gzip-cut`)).toBe('APP_WEB_FETCH_HTTP');
  }, 60_000);

  it('reads a page made to stall patterns over it in seconds, not hours', async () => {
    for (const trap of ['/meta-trap', '/title-trap']) {
      const started = Date.now();
      await reader.read(`${base}${trap}`, 0).catch(() => undefined);
      expect(Date.now() - started, trap).toBeLessThan(15_000);
    }
  }, 60_000);

  it('takes the title of an address in an old Russian encoding as written, and stops with «Стоп»', async () => {
    expect((await reader.read(`${base}/%EF%F0%E0%E9%F1.pdf`, 0)).title).toBe('%EF%F0%E0%E9%F1.pdf');
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 100);
    const started = Date.now();
    const failure = (await reader.read(`${base}/slow`, 0, stop.signal).catch((error: unknown) => error)) as { code?: string; name?: string };
    expect(failure.code).not.toBe('APP_WEB_FETCH_TIMEOUT');
    expect(failure.name).toBe('AbortError');
    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS);
  }, 60_000);

  it('names each failure of a site with its own code', async () => {
    expect(await codeOf(`${base}/missing`)).toBe('APP_WEB_FETCH_HTTP');
    expect(await codeOf(`${base}/forbidden`)).toBe('APP_WEB_FETCH_BLOCKED_BY_SITE');
    expect(await codeOf(`${base}/ddos`)).toBe('APP_WEB_FETCH_BLOCKED_BY_SITE');
    expect(await codeOf(`${base}/slow`)).toBe('APP_WEB_FETCH_TIMEOUT');
    expect(await codeOf(`${base}/huge`)).toBe('APP_WEB_FETCH_TOO_LARGE');
    expect(await codeOf(`${base}/picture.png`)).toBe('APP_WEB_FETCH_UNSUPPORTED');
    expect(await codeOf(`${base}/empty`)).toBe('APP_WEB_FETCH_NO_TEXT');
  }, 60_000);
});
