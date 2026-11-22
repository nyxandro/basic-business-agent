// How a background task starts (docs/specs/[20.11.2026]-event-tasks.md): by its schedule, on a letter in an
// employee's mailbox, or on a message another system sends to the task's address. Here — what an admin's input of each
// kind becomes in the row of the task, the secret of the address, and the filter of letters.
import { createHash, randomBytes } from 'node:crypto';
import type { MailFilter, TaskCreate, TaskTrigger, TaskUpdate } from '@bba/contracts';
import type { SecretBox } from '../crypto/secret-box.ts';
import type { Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';

export const HOOK_PATH = '/app/api/hooks/';
const SECRET_BYTES = 24;

export const secretHash = (secret: string): string => createHash('sha256').update(secret).digest('hex');

export interface HookSecret {
  secret: string;
  hash: string;
  ciphertext: Buffer;
  iv: Buffer;
  keyVersion: number;
}

export function newHookSecret(box: SecretBox): HookSecret {
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  const sealed = box.seal(secret);
  return { secret, hash: secretHash(secret), ciphertext: sealed.ciphertext, iv: sealed.iv, keyVersion: sealed.keyVersion };
}

export const hookUrl = (publicUrl: string, secret: string): string => `${publicUrl.replace(/\/+$/, '')}${HOOK_PATH}${secret}`;

// «ё» is «е», case does not matter: a subject «Счёт» fits the word «счет».
export const foldText = (text: string): string => text.toLowerCase().replaceAll('ё', 'е');

const ADDRESS_OR_DOMAIN = /^(?:[^\s@]+@)?[^\s@]+\.[^\s@]+$/;

// The filter as kept: trimmed, folded, without empty or repeated items. A sender is an address or a domain.
export function cleanMailFilter(filter: MailFilter): MailFilter {
  const clean = (items: readonly string[]) => [...new Set(items.map((i) => foldText(i.trim())).filter((i) => i !== ''))];
  const from = clean(filter.from).map((i) => i.replace(/^@/, ''));
  const wrong = from.find((i) => !ADDRESS_OR_DOMAIN.test(i));
  if (wrong) throw appError('APP_VALIDATION_FAILED', `bad sender filter "${wrong}"`, { userMessage: `«${wrong}» — не адрес и не домен. Пишите адреса или домены через запятую, например sale@vector.ru, vector.ru.` });
  return { from, subject: clean(filter.subject) };
}

// Does a letter fit the filter: the sender — any address or domain of the list, the subject — any word; both.
export function letterFits(filter: MailFilter, letter: { from: string; subject: string }): boolean {
  const from = foldText(letter.from.trim());
  const domain = from.slice(from.lastIndexOf('@') + 1);
  const sender = filter.from.length === 0 || filter.from.some((item) => (item.includes('@') ? item === from : domain === item || domain.endsWith(`.${item}`)));
  const subject = foldText(letter.subject);
  return sender && (filter.subject.length === 0 || filter.subject.some((word) => subject.includes(word)));
}

export async function assertExecutor(db: Db, userId: string): Promise<void> {
  const { rows } = await db.query<{ blocked: boolean }>(
    `SELECT COALESCE(p.blocked_at IS NOT NULL OR p.deletion_started_at IS NOT NULL, false) AS blocked
       FROM app."user" u LEFT JOIN app.user_profiles p ON p.user_id = u."id" WHERE u."id" = $1`,
    [userId],
  );
  if (!rows[0]) throw appError('APP_VALIDATION_FAILED', `executor ${userId} not found`, { userMessage: 'Выберите, от чьего имени работает агент.' });
  if (rows[0].blocked) throw appError('APP_VALIDATION_FAILED', `executor ${userId} is blocked`, { userMessage: 'Этот сотрудник заблокирован. Выберите другого.' });
}

// A change may touch only the fields of the task's own kind: the kind of a task does not change.
export function assertChangeFits(trigger: TaskTrigger, change: TaskUpdate): void {
  const foreign = [
    ...(trigger !== 'schedule' && change.schedule ? ['schedule'] : []),
    ...(trigger !== 'mail' && change.mailFilter ? ['mailFilter'] : []),
    ...(trigger !== 'webhook' && change.executorId ? ['executorId'] : []),
    ...(trigger === 'webhook' && change.access ? ['access'] : []),
  ];
  if (foreign.length > 0) throw appError('APP_VALIDATION_FAILED', `fields ${foreign.join(', ')} do not fit a ${trigger} task`, { userMessage: 'Вид запуска у созданной задачи не меняется. Создайте новую задачу.' });
}

// The scope of a webhook task is its executor: the run is theirs, checked as any run (blocked, no access).
export const executorScope = (executorId: string) => ({ scope: 'users' as const, departmentIds: [], userIds: [executorId] });

export const accessOf = (input: TaskCreate) => (input.trigger === 'webhook' ? executorScope(input.executorId) : input.access);
