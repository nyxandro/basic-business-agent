// A stand-in for SearXNG behind the search of the test gateway (spec, section 8.30): answers its JSON search with
// the results a test gives and keeps what it was asked. Listens on TEST_SEARXNG_PORT in core/models/gateway.test.ts.
import http from 'node:http';

export interface FakeSearxResult {
  title: string;
  url: string;
  content: string;
}

export interface FakeSearxng {
  queries: { q: string; language: string | null; format: string | null }[];
  setResults(results: FakeSearxResult[]): void;
  close(): Promise<void>;
}

export async function startFakeSearxng(opts: { port: number; host: string }): Promise<FakeSearxng> {
  const queries: FakeSearxng['queries'] = [];
  let results: FakeSearxResult[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    if (url.pathname !== '/search') {
      res.writeHead(404).end();
      return;
    }
    queries.push({ q: url.searchParams.get('q') ?? '', language: url.searchParams.get('language'), format: url.searchParams.get('format') });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ query: url.searchParams.get('q'), results: results.map((r) => ({ ...r, publishedDate: null })) }));
  });
  await new Promise<void>((resolve) => server.listen(opts.port, opts.host, resolve));
  return {
    queries,
    setResults: (next) => {
      results = next;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
