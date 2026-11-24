// A file the agent writes onto the person's computer (spec, section 8.25, «Запись в папку»). The browser writes it; before
// that the server keeps, in the hidden «.computer-saved» of the conversation's working folder, a snapshot of the file — the
// chat opens it later, whatever happens on the computer — and the version on the computer it is about to replace, which
// «Вернуть прежнюю версию» puts back and the daily sweep removes after 30 days. Stored in a bucket like any file of the
// project, never among «Файлы проекта».
import { randomBytes } from 'node:crypto';
import { COMPUTER_BEFORE, COMPUTER_SAVES, MAX_UPLOAD_BYTES, type ComputerSaveResponse } from '@bba/contracts';
import { appError } from '../errors/catalog.ts';
import { existingInside, putInFolder, readFileInside, removeFileInside } from '../workspace/layout.ts';
import { walkRegularFiles } from '../workspace/held-folder.ts';

// A number of its own for each write: two writes of one file a moment apart keep both snapshots.
const saveId = () => `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
const SAVE_ID = /^[a-z0-9]{1,16}-[0-9a-f]{8}$/;

// A snapshot and a replaced version at most, with the fields of the form.
export const COMPUTER_SAVE_MAX_BODY = 2 * MAX_UPLOAD_BYTES + 64 * 1024;

export function prepareComputerSave(folder: string, input: { userId: string; source: string; target: string; previous: Uint8Array | null }): ComputerSaveResponse {
  const read = readFileInside(folder, input.source, MAX_UPLOAD_BYTES);
  if (!read) throw appError('APP_NOT_FOUND', `no file ${input.source} in the working folder`, { userMessage: `Файла «${input.source}» нет в рабочей папке.` });
  if (!read.bytes) throw appError('APP_UPLOAD_TOO_LARGE', `${input.source} is ${read.size} bytes`, { userMessage: 'Файл больше 20 МБ — на компьютер его не записать.' });
  const name = input.target.split(/[\\/]/).filter(Boolean).pop();
  if (!name) throw appError('APP_VALIDATION_FAILED', 'no name of the file on the computer', { userMessage: 'Не указан путь файла на компьютере.' });
  const id = saveId();
  const base = `${COMPUTER_SAVES}/${input.userId}/${id}`;
  const snapshot = putInFolder(folder, base, name, read.bytes);
  const previous = input.previous ? putInFolder(folder, `${base}/${COMPUTER_BEFORE}`, name, input.previous).path : null;
  return { id, name: snapshot.path.split('/').pop()!, bytes: snapshot.bytes, snapshot: snapshot.path, previous };
}

// The browser could not write the file (it is open in another program, the disk is full): its save goes, so failed
// tries do not pile up. Only the person's own saves; files reached without following a link the agent may have put there.
export function discardComputerSave(folder: string, userId: string, id: string): void {
  if (!SAVE_ID.test(id)) throw appError('APP_VALIDATION_FAILED', `bad computer save id ${id}`, { userMessage: 'Неверный номер записи.' });
  const base = existingInside(folder, `${COMPUTER_SAVES}/${userId}/${id}`);
  if (!base) throw appError('APP_NOT_FOUND', `no computer save ${id}`, { userMessage: 'Такой записи нет.' });
  const files: string[] = [];
  walkRegularFiles(base, (file) => void files.push(file.rel), true);
  for (const rel of files) removeFileInside(base, rel);
}
