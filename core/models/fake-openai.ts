// Test helper: an OpenAI-compatible chat endpoint that records every request and answers from a
// script — text or tool calls. Lets tests see exactly what reached "the model" (e.g. masking).
// Listening on 0.0.0.0, it is a provider the test LiteLLM in Docker reaches (`dockerUrl`); with
// `acceptKey` it refuses other keys like OpenAI does. It also recognises speech: any audio → «Тестовая речь».
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CALL_HEADER, NAMING_CALL } from './usage.ts';

// Seconds of silence as a real WAV file: LiteLLM measures the length of what it sends.
export function silentWav(seconds: number): Uint8Array {
  const rate = 16_000;
  const data = Buffer.alloc(rate * seconds * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return new Uint8Array(Buffer.concat([head, data]));
}

// The error frame LiteLLM's proxy sends inside a stream that broke after it started
// (proxy_server.async_data_generator: `data: {"error": ProxyException.to_dict()}`).
export interface GatewayStreamError {
  message: string;
  type: string | null;
  param: string | null;
  code: string;
}

export type FakeTurn =
  // `cut` breaks the stream after the text: 'drop' closes the connection as a provider that went
  // away (what LiteLLM sees), an error frame is what LiteLLM then sends on, 'hang' goes silent with
  // the connection open.
  | { text: string; chunkSize?: number; delayMs?: number; cut?: StreamCut }
  | { toolCalls: { name: string; args: Record<string, unknown> }[] }
  | { status: number; error: string }
  // The connection closes before any answer, as a provider or a proxy that restarted.
  | { reset: true };

export interface FakeRequest {
  model: string;
  stream: boolean;
  messages: { role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string }[];
  tools?: { function: { name: string } }[];
  // What the gateway added from the deployment (spec, section 8.19).
  max_tokens?: number;
  max_completion_tokens?: number;
  reasoning_format?: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface FakeModel {
  url: string;
  // Headers of the speech recognition requests it got.
  transcriptions: Record<string, string | string[] | undefined>[];
  // The same server as LiteLLM in Docker sees it (host.docker.internal).
  dockerUrl: string;
  requests: FakeRequest[];
  script(...turns: (FakeTurn | ((req: FakeRequest) => FakeTurn))[]): void;
  // The service call that names a conversation (core/chat/naming.ts) has its own record and script:
  // it runs beside the agent's turn and must never take a turn scripted for the agent.
  namingRequests: FakeRequest[];
  scriptNaming(...turns: (FakeTurn | ((req: FakeRequest) => FakeTurn))[]): void;
  // Forgets the scripted turns nobody asked for, so they do not answer the next test.
  clear(): void;
  close(): Promise<void>;
}

const USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
// As OpenAI and Groq answer: LiteLLM's Groq provider reads it from every whole answer.
const SERVICE_TIER = 'default';
export const FAKE_TRANSCRIPT = 'Тестовая речь';

type StreamCut = 'drop' | 'hang' | GatewayStreamError;

function sse(res: import('node:http').ServerResponse, chunks: object[], finish: string, cut?: StreamCut): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const base = { id: 'fake', object: 'chat.completion.chunk', created: 1, model: 'fake' };
  for (const delta of chunks) res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  if (cut === 'drop') {
    // Let the text reach the reader before the connection goes, as a provider that sent a few
    // words and went away.
    setTimeout(() => res.socket?.destroy(), 50);
    return;
  }
  if (cut === 'hang') return;
  if (cut) res.write(`data: ${JSON.stringify({ error: cut })}\n\n`);
  else res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: USAGE })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function respond(res: import('node:http').ServerResponse, turn: FakeTurn, stream: boolean): void {
  if ('reset' in turn) {
    res.socket?.destroy();
    return;
  }
  if ('status' in turn) {
    res.writeHead(turn.status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: turn.error, type: 'error', code: turn.status } }));
    return;
  }
  if ('toolCalls' in turn) {
    const calls = turn.toolCalls.map((c, i) => ({ id: `call_${Date.now()}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
    if (stream) return sse(res, [{ role: 'assistant', tool_calls: calls.map((c, index) => ({ index, ...c })) }], 'tool_calls');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'fake', object: 'chat.completion', created: 1, model: 'fake', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: calls }, finish_reason: 'tool_calls' }], usage: USAGE, service_tier: SERVICE_TIER }));
    return;
  }
  if (stream) {
    const size = turn.chunkSize ?? 8;
    const parts: object[] = [];
    for (let i = 0; i < turn.text.length; i += size) parts.push(i === 0 ? { role: 'assistant', content: turn.text.slice(i, i + size) } : { content: turn.text.slice(i, i + size) });
    return sse(res, parts.length ? parts : [{ role: 'assistant', content: '' }], 'stop', turn.cut);
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ id: 'fake', object: 'chat.completion', created: 1, model: 'fake', choices: [{ index: 0, message: { role: 'assistant', content: turn.text }, finish_reason: 'stop' }], usage: USAGE, service_tier: SERVICE_TIER }));
}

// `fallback` answers when the script is empty (the browser stand answers by keywords); without it
// the model says «Готово.». `naming` answers the naming call when its script is empty; without it
// the model says «-» (the task is not clear yet), so the name stays as it was.
export async function startFakeModel(
  opts: { fallback?: (req: FakeRequest) => FakeTurn; naming?: (req: FakeRequest) => FakeTurn; host?: '127.0.0.1' | '0.0.0.0'; acceptKey?: string } = {},
): Promise<FakeModel> {
  const requests: FakeRequest[] = [];
  const namingRequests: FakeRequest[] = [];
  const transcriptions: FakeModel['transcriptions'] = [];
  const queue: (FakeTurn | ((req: FakeRequest) => FakeTurn))[] = [];
  const namingQueue: (FakeTurn | ((req: FakeRequest) => FakeTurn))[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('latin1')));
    req.on('end', () => {
      if (opts.acceptKey && req.headers.authorization !== `Bearer ${opts.acceptKey}`) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } }));
        return;
      }
      if (req.url?.endsWith('/audio/transcriptions')) {
        transcriptions.push(req.headers);
        res.setHeader('content-type', 'application/json');
        // As the providers answer: gpt-4o-*-transcribe counts tokens, whisper-like ones do not
        // (LiteLLM measures the length of the audio itself for them).
        const providerModel = /name="model"\r\n\r\n([^\r]+)/.exec(body)?.[1] ?? '';
        const usage = providerModel.includes('whisper') ? {} : { usage: { type: 'tokens', input_tokens: 50, output_tokens: 10, total_tokens: 60, input_token_details: { text_tokens: 0, audio_tokens: 50 } } };
        res.end(JSON.stringify({ text: FAKE_TRANSCRIPT, ...usage }));
        return;
      }
      const parsed = JSON.parse(Buffer.from(body, 'latin1').toString('utf8')) as Omit<FakeRequest, 'headers'>;
      const record: FakeRequest = { ...parsed, stream: Boolean(parsed.stream), headers: req.headers };
      const naming = req.headers[CALL_HEADER] === NAMING_CALL;
      (naming ? namingRequests : requests).push(record);
      const next = naming ? (namingQueue.shift() ?? opts.naming ?? { text: '-' }) : (queue.shift() ?? opts.fallback ?? { text: 'Готово.' });
      const turn = typeof next === 'function' ? next(record) : next;
      const delay = 'delayMs' in turn ? (turn.delayMs ?? 0) : 0;
      setTimeout(() => respond(res, turn, record.stream), delay);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, opts.host ?? '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    transcriptions,
    dockerUrl: `http://host.docker.internal:${port}/v1`,
    requests,
    script: (...turns) => void queue.push(...turns),
    namingRequests,
    scriptNaming: (...turns) => void namingQueue.push(...turns),
    clear: () => {
      queue.splice(0);
      namingQueue.splice(0);
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        // A silent stream keeps its connection until the reader gives up.
        server.closeAllConnections();
      }),
  };
}
