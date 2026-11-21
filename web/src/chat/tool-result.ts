// What a tool call ended with, read from its result text: data, a failure (with our code when
// the server put one there) or a refusal of the person (DeclinedToolResult from the server).
import type { DeclinedToolResult } from '@bba/contracts';

export type ToolOutcome =
  | { kind: 'ok'; value: unknown }
  | { kind: 'failed'; code: string | null; message: string | null }
  // `expiredHours` — the question burnt unanswered after so many hours (docs/specs/[20.11.2026]-notifications.md, F4).
  | { kind: 'declined'; superseded: boolean; expiredHours: number | null };

const CODE = /\bAPP_[A-Z0-9_]+\b/;

function parse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const isDeclined = (v: unknown): v is DeclinedToolResult => typeof v === 'object' && v !== null && (v as { declined?: unknown }).declined === true;

export function parseToolResult(raw: string | undefined | null): ToolOutcome {
  if (raw === undefined || raw === null) return { kind: 'ok', value: null };
  const value = parse(raw);
  if (isDeclined(value)) return { kind: 'declined', superseded: value.superseded, expiredHours: typeof value.expiredHours === 'number' ? value.expiredHours : null };
  // Mastra returns a failed or refused-by-schema call as { error: true, message } to the model.
  if (typeof value === 'object' && value !== null && (value as { error?: unknown }).error) {
    const message = (value as { message?: unknown }).message;
    return { kind: 'failed', code: CODE.exec(JSON.stringify(value))?.[0] ?? null, message: typeof message === 'string' ? message : null };
  }
  return { kind: 'ok', value };
}
