// A file of an employee's folder as a download (spec, sections 8.9 and 8.18): «Файлы проекта» and the
// file block of the chat. Always an attachment with the type from the extension and `nosniff`, so a
// file the agent wrote (HTML, SVG) is saved, never opened as a page of our address.
import { createReadStream } from 'node:fs';
import { basename, extname } from 'node:path';
import { Readable } from 'node:stream';
import { appError } from '../errors/catalog.ts';
import { openFileInside, resolveInside } from './layout.ts';

const CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword',
  '.xls': 'application/vnd.ms-excel',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};
// Any other file the agent made is still a file to save.
const OTHER = 'application/octet-stream';

// `missing`: what the person reads when there is no such file (it was removed, or the folder changed).
export function fileDownload(dir: string, path: string, missing: string): Response {
  const file = openFileInside(dir, path);
  if (!file) throw appError('APP_NOT_FOUND', 'no such file in the folder', { userMessage: missing });
  // The name the person sees is the one in the folder (a link inside it keeps its own name).
  const name = basename(resolveInside(dir, path));
  // Streamed from the opened file: a big file does not fill the memory of the server.
  const body = Readable.toWeb(createReadStream('', { fd: file.fd, autoClose: true })) as ReadableStream<Uint8Array>;
  return new Response(body, {
    headers: {
      'content-length': String(file.size),
      'content-type': CONTENT_TYPES[extname(name).toLowerCase()] ?? OTHER,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'x-content-type-options': 'nosniff',
    },
  });
}
