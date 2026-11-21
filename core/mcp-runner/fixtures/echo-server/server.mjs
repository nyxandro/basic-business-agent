#!/usr/bin/env node
// A tiny MCP server over stdio (JSON-RPC, one message per line) for the tests of mcp-runner. No dependencies: in the
// sandbox only its own folder is there. Its actions tell the tests what the program sees: its arguments, its
// environment, its files — and one of them makes it fall.
import { existsSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';

const TOOLS = [
  { name: 'echo', description: 'Повторить текст', inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Текст' } }, required: ['text'] } },
  { name: 'whoami', description: 'Что видит программа', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'fall', description: 'Упасть', inputSchema: { type: 'object', properties: {} } },
];

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });

function call(name, args) {
  if (name === 'echo') return text(args.text);
  if (name === 'whoami') {
    // What a program in the sandbox could take: the environment, the files of the container, the database by name.
    return text({ args: process.argv.slice(2), env: process.env, root: readdirSync('/'), app: existsSync('/app'), workspace: existsSync('/workspace') });
  }
  if (name === 'fall') process.exit(3);
  throw new Error(`unknown tool ${name}`);
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  switch (message.method) {
    case 'initialize':
      return send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'bba-echo-mcp', version: '1.0.0' } } });
    case 'ping':
      return send({ id: message.id, result: {} });
    case 'tools/list':
      return send({ id: message.id, result: { tools: TOOLS } });
    case 'tools/call':
      try {
        return send({ id: message.id, result: call(message.params.name, message.params.arguments ?? {}) });
      } catch (error) {
        return send({ id: message.id, result: { ...text(String(error.message)), isError: true } });
      }
    default:
      // `server/discover` of the 2026-07-28 revision too: the client falls back to `initialize`.
      return send({ id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } });
  }
});
