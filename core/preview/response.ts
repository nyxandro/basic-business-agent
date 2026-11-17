// The viewer's PDF as an answer (spec, section 8.27): shown in place, never kept by a shared cache, and in
// parts when PDF.js asks for them (`Range`) — the first page shows before the whole file has come.
import { createReadStream } from 'node:fs';
import { basename, extname } from 'node:path';
import { Readable } from 'node:stream';

// The bytes `start`…`end` of `size`, or null for the whole file; 'invalid' — outside the file.
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  // Several ranges in one request PDF.js never asks: the whole file answers them.
  if (!match || (match[1] === '' && match[2] === '')) return null;
  const [, from, to] = match;
  if (from === '') {
    const suffix = Number(to);
    if (suffix === 0) return 'invalid';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(from);
  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

// `name`: the document's own name; the PDF is called by it.
export function pdfResponse(pdf: { path: string; bytes: number }, name: string, rangeHeader: string | undefined): Response {
  const headers: Record<string, string> = {
    'content-type': 'application/pdf',
    'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(`${basename(name, extname(name))}.pdf`)}`,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'accept-ranges': 'bytes',
  };
  const range = parseRange(rangeHeader, pdf.bytes);
  if (range === 'invalid') return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${pdf.bytes}` } });
  const stream = createReadStream(pdf.path, range ?? {});
  const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
  if (!range) return new Response(body, { headers: { ...headers, 'content-length': String(pdf.bytes) } });
  return new Response(body, {
    status: 206,
    headers: { ...headers, 'content-length': String(range.end - range.start + 1), 'content-range': `bytes ${range.start}-${range.end}/${pdf.bytes}` },
  });
}
