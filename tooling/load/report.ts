// The results of a stage: by kind of action — how many, how many failed and why, how long to the first sign of life and to
// the end (the middle and the slowest 5 %) — and a short print of it.
export interface Result {
  kind: 'question' | 'table' | 'document' | 'search' | 'web' | 'preview';
  ok: boolean;
  code: string | null;
  status: number;
  // The first words or call of the answer; for a plain request — the whole of it.
  firstMs: number | null;
  totalMs: number;
}

interface KindSummary {
  n: number;
  ok: number;
  firstP50: number | null;
  firstP95: number | null;
  totalP50: number | null;
  totalP95: number | null;
  totalMax: number | null;
}

const percentile = (values: number[], p: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
};

export function summaryOf(results: Result[]): { actions: number; ok: number; failed: number; codes: Record<string, number>; byKind: Record<string, KindSummary> } {
  const byKind: Record<string, KindSummary> = {};
  for (const kind of new Set(results.map((r) => r.kind))) {
    const ok = results.filter((r) => r.kind === kind && r.ok);
    const first = ok.map((r) => r.firstMs ?? r.totalMs);
    const total = ok.map((r) => r.totalMs);
    byKind[kind] = {
      n: results.filter((r) => r.kind === kind).length,
      ok: ok.length,
      firstP50: percentile(first, 50),
      firstP95: percentile(first, 95),
      totalP50: percentile(total, 50),
      totalP95: percentile(total, 95),
      totalMax: percentile(total, 100),
    };
  }
  const codes: Record<string, number> = {};
  for (const r of results) if (!r.ok) codes[r.code ?? 'UNKNOWN'] = (codes[r.code ?? 'UNKNOWN'] ?? 0) + 1;
  const ok = results.filter((r) => r.ok).length;
  return { actions: results.length, ok, failed: results.length - ok, codes, byKind };
}

const sec = (ms: number | null) => (ms === null ? '-' : (ms / 1000).toFixed(1));

export function printSummary(stage: {
  mode: string;
  a: number;
  seconds: number | null;
  tookSeconds: number;
  peakInFlight: number;
  stoppedForMemory: boolean;
  actions: number;
  ok: number;
  failed: number;
  codes: Record<string, number>;
  byKind: Record<string, KindSummary>;
  peak: { serverCpu: number; serverRss: number; children: number; childrenRss: number; dbConns: number; minFreeMb: number; litellm: string };
  journal: Record<string, number> | string;
}): void {
  const load = stage.mode === 'flow' ? `${stage.a}/min for ${stage.seconds} s` : `${stage.a} at once`;
  const failed = stage.failed > 0 ? ` ${JSON.stringify(stage.codes)}` : '';
  console.log(`${stage.mode} ${load} | took ${stage.tookSeconds} s | actions ${stage.actions}, ok ${stage.ok}, failed ${stage.failed}${failed} | peak in flight ${stage.peakInFlight}${stage.stoppedForMemory ? ' | STOPPED FOR MEMORY' : ''}`);
  for (const [kind, k] of Object.entries(stage.byKind)) {
    console.log(`  ${kind.padEnd(9)} n=${String(k.n).padStart(4)} ok=${String(k.ok).padStart(4)}  first p50 ${sec(k.firstP50)} p95 ${sec(k.firstP95)} | total p50 ${sec(k.totalP50)} p95 ${sec(k.totalP95)} max ${sec(k.totalMax)}`);
  }
  const p = stage.peak;
  console.log(`  server cpu ${p.serverCpu}% rss ${p.serverRss} MB | children ${p.children} rss ${p.childrenRss} MB | db connections ${p.dbConns} | free memory min ${p.minFreeMb} MB | litellm ${p.litellm}`);
  console.log(`  journal: ${typeof stage.journal === 'string' ? stage.journal : JSON.stringify(stage.journal)}`);
}
