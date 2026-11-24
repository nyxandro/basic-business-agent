// The load of a stage against the stand of tooling/load/stand.ts (review 24.11, issue #35).
//   pnpm load burst <n>                 — n people act at the same moment, one action each
//   pnpm load flow <perMinute> <seconds> — actions come at random moments, perMinute on average, for `seconds`
// An action is a question, a table, a Word document (opened in the viewer half the time — LibreOffice), a search or a search
// of the internet, in the mix of an ordinary day (MIX). Every second it samples the server (CPU, memory), its children
// (sandbox, LibreOffice), the free memory of the machine and the connections to the database, and stops starting actions
// when the machine has less than MIN_FREE_MB free. Prints a summary; the whole stage goes to .data/load/results.jsonl.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import pg from 'pg';
import { STAND_DOCUMENT } from '../../tests/e2e/stand-model.ts';
import { RESULTS_FILE, STAND_FILE, STAND_LOG, type LoadStand } from './files.ts';
import { descendants, freeMb, cpuTicks, rssMb, TICKS_PER_SECOND } from './machine.ts';
import { printSummary, summaryOf, type Result } from './report.ts';

const BASE = 'http://127.0.0.1:3000';
const MIN_FREE_MB = 1500;
const ACTION_TIMEOUT_MS = 180_000;
const SAMPLE_MS = 1000;
// The gateway's container: its memory and CPU every few samples (docker stats is slow).
const LITELLM_CONTAINER = 'bba-dev-litellm-test-1';
const LITELLM_EVERY = 5;

type Kind = 'question' | 'table' | 'document' | 'search' | 'web';
// A day of ordinary work: mostly questions and documents, some tables, searches and the internet.
const MIX: [Kind, number][] = [
  ['question', 35],
  ['table', 15],
  ['document', 25],
  ['search', 15],
  ['web', 10],
];
const PREVIEW_SHARE = 0.5;
// The words the stand-in model answers to (tests/e2e/stand-model.ts).
const TEXT: Record<Exclude<Kind, 'search'>, string> = {
  question: 'Подскажи условия поставки бетона на объект',
  table: 'Покажи таблицу сделок',
  document: 'Сделай документ Word с коммерческим предложением',
  web: 'Найди в интернете цену профнастила',
};

if (!existsSync(STAND_FILE)) throw new Error(`no ${STAND_FILE}: start the stand first (pnpm load:stand)`);
const stand = JSON.parse(readFileSync(STAND_FILE, 'utf8')) as LoadStand;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set: run with the .env of the project (pnpm load)');

function pickKind(): Kind {
  let left = Math.random() * MIX.reduce((s, [, w]) => s + w, 0);
  for (const [kind, weight] of MIX) if ((left -= weight) < 0) return kind;
  return MIX[0]![0];
}

type Person = LoadStand['people'][number];
const headers = (p: Person, json = false): Record<string, string> => ({ cookie: p.cookie, 'x-forwarded-for': p.ip, ...(json ? { 'content-type': 'application/json' } : {}) });

async function codeOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
  return body?.error?.code ?? `HTTP_${res.status}`;
}

// One answer of the agent: the stream of its events is read to the end.
async function chat(p: Person, kind: Exclude<Kind, 'search'>): Promise<{ result: Result; threadId: string }> {
  const threadId = randomUUID();
  const started = Date.now();
  const signal = AbortSignal.timeout(ACTION_TIMEOUT_MS);
  const failed = (code: string, status: number): { result: Result; threadId: string } => ({ threadId, result: { kind, ok: false, code, status, firstMs: null, totalMs: Date.now() - started } });
  try {
    const res = await fetch(`${BASE}/app/api/copilotkit/agent/sales/run`, {
      method: 'POST',
      headers: headers(p, true),
      body: JSON.stringify({ threadId, runId: randomUUID(), messages: [{ id: randomUUID(), role: 'user', content: TEXT[kind] }], tools: [], context: [], state: {}, forwardedProps: {} }),
      signal,
    });
    if (!res.ok || !res.body) return failed(await codeOf(res), res.status);
    let first: number | null = null;
    let error: string | null = null;
    let finished = false;
    let buffer = '';
    const decoder = new TextDecoder();
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const event = JSON.parse(line.slice(5)) as { type: string; code?: string };
        // The first sign of life: words of the answer or a call of a tool.
        if (first === null && /^(TEXT_MESSAGE_(CONTENT|CHUNK)|TOOL_CALL_START)$/.test(event.type)) first = Date.now() - started;
        if (event.type === 'RUN_ERROR') error = event.code ?? 'RUN_ERROR';
        if (event.type === 'RUN_FINISHED') finished = true;
      }
    }
    const ok = finished && error === null;
    return { threadId, result: { kind, ok, code: ok ? null : (error ?? 'NO_RUN_FINISHED'), status: res.status, firstMs: first, totalMs: Date.now() - started } };
  } catch (error) {
    return failed(signal.aborted ? 'CLIENT_TIMEOUT' : `CLIENT_${(error as Error).name}`, 0);
  }
}

async function get(p: Person, kind: 'search' | 'preview', path: string): Promise<Result> {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}${path}`, { headers: headers(p), signal: AbortSignal.timeout(ACTION_TIMEOUT_MS) });
    const code = res.ok ? null : await codeOf(res);
    if (res.ok) await res.arrayBuffer();
    const totalMs = Date.now() - started;
    return { kind, ok: res.ok, code, status: res.status, firstMs: totalMs, totalMs };
  } catch (error) {
    return { kind, ok: false, code: `CLIENT_${(error as Error).name}`, status: 0, firstMs: null, totalMs: Date.now() - started };
  }
}

const results: Result[] = [];
let inFlight = 0;
let peakInFlight = 0;
let stopLaunching = false;

async function act(p: Person, kind: Kind): Promise<void> {
  inFlight++;
  peakInFlight = Math.max(peakInFlight, inFlight);
  try {
    if (kind === 'search') {
      results.push(await get(p, 'search', `/app/api/search?q=${encodeURIComponent('коммерческое предложение')}&scope=all`));
      return;
    }
    const { result, threadId } = await chat(p, kind);
    const file = `/app/api/threads/${threadId}/file`;
    // The document is there to download: its status says so.
    if (kind === 'document' && result.ok) {
      const status = await fetch(`${BASE}${file}/status?path=${encodeURIComponent(STAND_DOCUMENT)}`, { headers: headers(p) });
      if (!status.ok) Object.assign(result, { ok: false, code: `NO_DOCUMENT_${await codeOf(status)}` });
    }
    results.push(result);
    if (kind === 'document' && result.ok && Math.random() < PREVIEW_SHARE) results.push(await get(p, 'preview', `${file}/preview?path=${encodeURIComponent(STAND_DOCUMENT)}`));
  } finally {
    inFlight--;
  }
}

export interface Peak {
  serverCpu: number;
  serverRss: number;
  childrenRss: number;
  children: number;
  dbConns: number;
  minFreeMb: number;
  litellm: string;
}

async function monitor(stopped: () => boolean): Promise<Peak> {
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  const peak: Peak = { serverCpu: 0, serverRss: 0, childrenRss: 0, children: 0, dbConns: 0, minFreeMb: Infinity, litellm: '' };
  let lastTicks = cpuTicks(stand.pid);
  let lastAt = Date.now();
  for (let n = 0; !stopped(); n++) {
    await new Promise((r) => setTimeout(r, SAMPLE_MS));
    const ticks = cpuTicks(stand.pid);
    const now = Date.now();
    peak.serverCpu = Math.max(peak.serverCpu, ((ticks - lastTicks) / TICKS_PER_SECOND / ((now - lastAt) / 1000)) * 100);
    lastTicks = ticks;
    lastAt = now;
    peak.serverRss = Math.max(peak.serverRss, rssMb(stand.pid));
    const kids = descendants(stand.pid);
    peak.children = Math.max(peak.children, kids.length);
    peak.childrenRss = Math.max(peak.childrenRss, kids.reduce((sum, kid) => sum + rssMb(kid), 0));
    const free = freeMb();
    peak.minFreeMb = Math.min(peak.minFreeMb, free);
    if (free < MIN_FREE_MB && !stopLaunching) {
      stopLaunching = true;
      console.log(`!! free memory ${Math.round(free)} MB < ${MIN_FREE_MB} MB: no new actions`);
    }
    // The driver's own connection is not counted.
    const { rows } = await db.query<{ c: number }>('SELECT count(*)::int AS c FROM pg_stat_activity WHERE datname = $1', [stand.database]);
    peak.dbConns = Math.max(peak.dbConns, rows[0]!.c);
    if (n % LITELLM_EVERY === 0) {
      try {
        peak.litellm = execFileSync('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}} cpu {{.CPUPerc}}', LITELLM_CONTAINER], { encoding: 'utf8' }).trim();
      } catch {
        // Docker did not answer this time: the next sample tries again.
      }
    }
  }
  await db.end();
  return peak;
}

// Warnings and errors the server wrote during the stage, by event and code.
function journalSince(offset: number | null): Record<string, number> | 'no stand.log' {
  if (offset === null) return 'no stand.log';
  const counts: Record<string, number> = {};
  for (const line of readFileSync(STAND_LOG, 'utf8').slice(offset).split('\n')) {
    const level = /"level":"(error|warn)"/.exec(line)?.[1];
    if (!level) continue;
    const key = [level, /"event":"([^"]+)"/.exec(line)?.[1] ?? 'unparsed', /"code":"(APP_[A-Z_]+)"/.exec(line)?.[1]].filter(Boolean).join(':');
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

const [mode, first, second] = process.argv.slice(2);
const a = Number(first);
const seconds = Number(second);
if (!(mode === 'burst' && a > 0) && !(mode === 'flow' && a > 0 && seconds > 0)) throw new Error('pnpm load burst <n> | flow <perMinute> <seconds>');
const offset = existsSync(STAND_LOG) ? statSync(STAND_LOG).size : null;
let done = false;
const peakSamples = monitor(() => done);
const started = Date.now();
if (mode === 'burst') {
  await Promise.all(Array.from({ length: a }, (_, i) => act(stand.people[i % stand.people.length]!, pickKind())));
} else {
  const until = started + seconds * 1000;
  const running: Promise<void>[] = [];
  for (let i = 0; Date.now() < until && !stopLaunching; i++) {
    running.push(act(stand.people[i % stand.people.length]!, pickKind()));
    // Random moments, `a` a minute on average (a Poisson flow).
    await new Promise((r) => setTimeout(r, -Math.log(1 - Math.random()) * (60_000 / a)));
  }
  await Promise.all(running);
}
done = true;
const peak = await peakSamples;
const stage = {
  at: new Date().toISOString(),
  mode,
  a,
  seconds: mode === 'flow' ? seconds : null,
  modelMs: stand.modelMs,
  longText: stand.longText,
  tookSeconds: Math.round((Date.now() - started) / 1000),
  peakInFlight,
  stoppedForMemory: stopLaunching,
  ...summaryOf(results),
  peak: { ...peak, serverCpu: Math.round(peak.serverCpu), serverRss: Math.round(peak.serverRss), childrenRss: Math.round(peak.childrenRss), minFreeMb: Math.round(peak.minFreeMb) },
  journal: journalSince(offset),
};
appendFileSync(RESULTS_FILE, `${JSON.stringify(stage)}\n`);
printSummary(stage);
