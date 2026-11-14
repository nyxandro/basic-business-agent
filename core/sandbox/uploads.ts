// Attachments of a conversation (spec, section 8.9): up to 20 MB, PDF/DOCX/XLSX/CSV/TXT/PNG/JPG,
// stored in /workspace/<userId>/uploads/<threadId>/ and removed with the conversation or the person.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { MAX_UPLOAD_BYTES, UPLOAD_EXTENSIONS } from '@bba/contracts';
import { appError } from '../errors/catalog.ts';
import { userDir } from './workspace.ts';

export { MAX_UPLOAD_BYTES };
export const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set(UPLOAD_EXTENSIONS);
const SAFE_THREAD_ID = /^[A-Za-z0-9:_-]{1,128}$/;

export function safeFileName(name: string): string {
  const last = name.split(/[\\/]/).pop() ?? '';
  const base = last.replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^\.+/, '').trim();
  return base.slice(-120) || 'file';
}

export function threadUploadsDir(workspaceRoot: string, userId: string, threadId: string): string {
  if (!SAFE_THREAD_ID.test(threadId)) throw appError('APP_VALIDATION_FAILED', `unsafe thread id ${threadId}`);
  return join(userDir(workspaceRoot, userId), 'uploads', threadId.replace(/:/g, '_'));
}

export function saveUpload(
  workspaceRoot: string,
  input: { userId: string; threadId: string; fileName: string; data: Uint8Array },
): { path: string; name: string; bytes: number } {
  const name = safeFileName(input.fileName);
  if (!ALLOWED_EXTENSIONS.has(extname(name).toLowerCase())) throw appError('APP_UPLOAD_TYPE_UNSUPPORTED', `extension of ${name} is not allowed`);
  if (input.data.byteLength > MAX_UPLOAD_BYTES) throw appError('APP_UPLOAD_TOO_LARGE', `${name} is ${input.data.byteLength} bytes`);
  const dir = threadUploadsDir(workspaceRoot, input.userId, input.threadId);
  mkdirSync(dir, { recursive: true });
  let target = join(dir, name);
  for (let i = 2; existsSync(target); i++) target = join(dir, `${i}-${name}`);
  writeFileSync(target, input.data);
  const relativePath = target.slice(userDir(workspaceRoot, input.userId).length + 1);
  return { path: relativePath, name, bytes: input.data.byteLength };
}

export function deleteThreadUploads(workspaceRoot: string, userId: string, threadId: string): void {
  rmSync(threadUploadsDir(workspaceRoot, userId, threadId), { recursive: true, force: true });
}

export function deleteUserWorkspace(workspaceRoot: string, userId: string): void {
  rmSync(userDir(workspaceRoot, userId), { recursive: true, force: true });
}
