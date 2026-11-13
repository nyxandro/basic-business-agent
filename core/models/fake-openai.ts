// Test helper: an OpenAI-compatible chat endpoint that records every request and answers from a
// script — text or tool calls. Lets tests see exactly what reached "the model" (e.g. masking).
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeTurn =
  | { text: string; chunkSize?: number }
  | { toolCalls: { name: string; args: Record<string, unknown> }[] };

export interface FakeRequest {
  model: string;
  stream: boolean;
  messages: { role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string }[];
  tools?: { function: { name: string } }[];
  headers: Record<string, string | string[] | undefined>;
}

export interface FakeModel {
  url: string;
  requests: FakeRequest[];
  script(...turns: (FakeTurn | ((req: FakeRequest) => FakeTurn))[]): void;
  close(): Promise<void>;
}

const USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

function sse(res: import('node:http').ServerResponse, chunks: object[], finish: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const base = { id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'fake' };
  for (const delta of chunks) res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: USAGE })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function respond(res: import('node:http').ServerResponse, turn: FakeTurn, stream: boolean): void {
  if ('toolCalls' in turn) {
    const calls = turn.toolCalls.map((c, i) => ({ id: `call_${Date.now()}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
    if (stream) return sse(res, [{ role: 'assistant', tool_calls: calls.map((c, index) => ({ index, ...c })) }], 'tool_calls');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'fake', object: 'chat.completion', created: 1, model: 'fake', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: calls }, finish_reason: 'tool_calls' }], usage: USAGE }));
    return;
  }
  if (stream) {
    const size = turn.chunkSize ?? 8;
    const parts: object[] = [];
    for (let i = 0; i < turn.text.length; i += size) parts.push(i === 0 ? { role: 'assistant', content: turn.text.slice(i, i + size) } : { content: turn.text.slice(i, i + size) });
    return sse(res, parts.length ? parts : [{ role: 'assistant', content: '' }], 'stop');
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ id: 'fake', object: 'chat.completion', created: 1, model: 'fake', choices: [{ index: 0, message: { role: 'assistant', content: turn.text }, finish_reason: 'stop' }], usage: USAGE }));
}

export async function startFakeModel(): Promise<FakeModel> {
  const requests: FakeRequest[] = [];
  const queue: (FakeTurn | ((req: FakeRequest) => FakeTurn))[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const parsed = JSON.parse(body) as Omit<FakeRequest, 'headers'>;
      const record: FakeRequest = { ...parsed, stream: Boolean(parsed.stream), headers: req.headers };
      requests.push(record);
      const next = queue.shift() ?? { text: 'Готово.' };
      respond(res, typeof next === 'function' ? next(record) : next, record.stream);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    script: (...turns) => void queue.push(...turns),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
