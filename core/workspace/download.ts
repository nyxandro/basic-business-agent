// A file of an employee's folder as a download (spec, sections 8.9, 8.18 and 8.21): «Файлы проекта», the
// file block of the chat and the search. An attachment with the type from the extension and `nosniff`, so a
// file the agent wrote (HTML, SVG) is saved, never opened as a page of our address. The document viewer
// reads the same answer itself (spec, section 8.27).
import { extname } from 'node:path';
import { Readable } from 'node:stream';
import { appError } from '../errors/catalog.ts';

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
// `name`: the name the person gets; a file of the trash lies under its id and is given under the name it had.
// The file comes from the disk or straight from the bucket (core/storage, spec section 8.23) and is streamed:
// a big file does not fill the memory of the server.
export function fileResponse(file: { stream: Readable; bytes: number } | null, missing: string, name: string): Response {
  if (!file) throw appError('APP_NOT_FOUND', 'no such file in the folder', { userMessage: missing });
  const body = Readable.toWeb(file.stream) as ReadableStream<Uint8Array>;
  return new Response(body, {
    headers: {
      'content-length': String(file.bytes),
      'content-type': CONTENT_TYPES[extname(name).toLowerCase()] ?? OTHER,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'x-content-type-options': 'nosniff',
    },
  });
}
