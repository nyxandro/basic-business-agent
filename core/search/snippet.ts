// The piece of text shown under a found conversation in «Поиск» (spec, section 8.13): ±60 characters
// of what the person saw in the chat around a match. The person's own text is shown as typed; an
// agent's answer without its Markdown (visible-text.ts), as the chat draws it.
import { visibleText } from './visible-text.ts';

export const SNIPPET_RADIUS = 60;
// Raw characters on each side of a match whose Markdown is parsed: parsing a whole long answer for
// each of 50 results took seconds (~60 ms for 20 000 characters), a window — about a millisecond.
const CONTEXT = 300;
// The window takes whole blocks (text between blank lines), so a table keeps its header row and a
// list its markers; a block reaching further than this is cut at a line, then mid-line.
const MAX_BLOCK_REACH = 1500;
// Parses of an answer per conversation, when the word turns out to be only in markup (a link's
// address): then the piece is the beginning of the conversation.
const MAX_PARSES = 3;

export interface MessageText {
  role: 'user' | 'assistant';
  text: string;
}

interface Visible {
  text: string;
  // Cut from a longer text before or after.
  before: boolean;
  after: boolean;
}

function windowStart(text: string, lo: number): number {
  if (lo <= 0) return 0;
  const block = Math.max(text.lastIndexOf('\n\n', lo), 0);
  if (lo - block <= MAX_BLOCK_REACH) return block;
  const line = text.lastIndexOf('\n', lo) + 1;
  return lo - line <= MAX_BLOCK_REACH ? line : lo;
}

function windowEnd(text: string, hi: number): number {
  if (hi >= text.length) return text.length;
  const found = text.indexOf('\n\n', hi);
  const block = found < 0 ? text.length : found;
  if (block - hi <= MAX_BLOCK_REACH) return block;
  const next = text.indexOf('\n', hi);
  const line = next < 0 ? text.length : next;
  return line - hi <= MAX_BLOCK_REACH ? line : hi;
}

// What the person saw of a message around a raw position: the window of an answer, parsed.
function visibleAround(message: MessageText, at: number, length: number): Visible {
  if (message.role === 'user') return { text: message.text.replace(/\s+/g, ' ').trim(), before: false, after: false };
  const from = windowStart(message.text, at - CONTEXT);
  const to = windowEnd(message.text, at + length + CONTEXT);
  return { text: visibleText(message.text.slice(from, to)), before: from > 0, after: to < message.text.length };
}

function cut(visible: Visible, at: number): string {
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(visible.text.length, at + SNIPPET_RADIUS);
  return `${visible.before || start > 0 ? '…' : ''}${visible.text.slice(start, end).trim()}${visible.after || end < visible.text.length ? '…' : ''}`;
}

// Words already visible in the title tell nothing new, so the piece is centred on a word found only
// in the messages when there is one; `terms` are lower case.
export function snippetOf(messages: MessageText[], title: string, terms: string[]): string {
  const titled = title.toLowerCase();
  const ordered = [...terms.filter((w) => !titled.includes(w)), ...terms.filter((w) => titled.includes(w))];
  let parses = 0;
  for (const word of ordered) {
    for (const message of messages) {
      const at = message.text.toLowerCase().indexOf(word);
      if (at < 0) continue;
      if (message.role === 'assistant' && ++parses > MAX_PARSES) return opening(messages);
      const visible = visibleAround(message, at, word.length);
      const found = visible.text.toLowerCase().indexOf(word);
      if (found >= 0) return cut(visible, found);
    }
  }
  return opening(messages);
}

// The beginning of the conversation: found by the title alone, or by markup only.
function opening(messages: MessageText[]): string {
  const first = messages[0];
  if (!first) return '';
  return cut(visibleAround(first, 0, 0), 0);
}
