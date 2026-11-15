// A file of an employee's folder as a download (spec, sections 8.9 and 8.18): «Файлы проекта» and the
// file block of the chat. Always an attachment with the type from the extension and `nosniff`, so a
// file the agent wrote (HTML, SVG) is saved, never opened as a page of our address.
import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { appError } from '../errors/catalog.ts';
import { resolveInside } from './layout.ts';

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
  const full = resolveInside(dir, path);
  if (!statSync(full, { throwIfNoEntry: false })?.isFile()) throw appError('APP_NOT_FOUND', 'no such file in the folder', { userMessage: missing });
  const name = basename(full);
  return new Response(readFileSync(full), {
    headers: {
      'content-type': CONTENT_TYPES[extname(name).toLowerCase()] ?? OTHER,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'x-content-type-options': 'nosniff',
    },
  });
}
