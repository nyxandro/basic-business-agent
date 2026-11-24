// A failure of a chat run in our code and words (spec, section 9.1): the text of RUN_ERROR, or the failure Mastra kept in
// a broken answer. Our own codes keep their text; a database that failed is told as such; the rest is the model's.
import { isConnectionLost, isPoolExhausted } from '../db/pool.ts';
import { ERROR_CATALOG } from '../errors/catalog.ts';
import type { ModelGateway } from '../models/gateway.ts';
import type { TranslatedError } from './stream.ts';

const told = (code: 'APP_SERVER_BUSY' | 'APP_DB_CONNECTION_LOST'): TranslatedError => ({ code, message: ERROR_CATALOG[code].userMessage });

export async function translateRunFailure(gateway: Pick<ModelGateway, 'translateError'>, userId: string, failure: unknown): Promise<TranslatedError> {
  const raw = typeof failure === 'string' ? failure : String((failure as { message?: unknown } | null)?.message ?? failure);
  const code = /^(APP_[A-Z0-9_]+):/.exec(raw)?.[1];
  const known = code ? (ERROR_CATALOG as Record<string, { userMessage: string }>)[code] : undefined;
  if (code && known) return { code, message: known.userMessage };
  const error = failure instanceof Error ? failure : new Error(raw);
  if (isPoolExhausted(error)) return told('APP_SERVER_BUSY');
  if (isConnectionLost(error)) return told('APP_DB_CONNECTION_LOST');
  const translated = await gateway.translateError(typeof failure === 'string' ? new Error(failure) : failure, userId);
  return { code: translated.code, message: translated.userMessage };
}
