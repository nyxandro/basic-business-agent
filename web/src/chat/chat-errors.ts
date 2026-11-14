// A failed turn as the person sees it. Our server answers refusals before the stream with its JSON
// (403, 402, 409) and failures inside the stream with RUN_ERROR carrying our code and text.
import { apiErrorSchema } from '@bba/contracts';
import { ApiRequestError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';

const CODE = /^APP_[A-Z0-9_]+$/;

function fromJsonIn(text: string): ApiRequestError | null {
  const start = text.indexOf('{"error"');
  if (start < 0) return null;
  try {
    const parsed = apiErrorSchema.safeParse(JSON.parse(text.slice(start)));
    if (!parsed.success) return null;
    const { code, message, nextStep } = parsed.data.error;
    return new ApiRequestError({ code, message, status: 0, ...(nextStep ? { nextStep } : {}) });
  } catch {
    return null;
  }
}

// `answerAgain`: the turn failed inside the run — the answer broke (spec, section 9.1). A refusal
// before the run is not helped by sending again, and after a lost connection to our server the
// answer may have arrived whole: the person reloads the page.
export interface ChatFailure {
  error: ApiRequestError;
  answerAgain: boolean;
}

export function chatFailureOf(error: unknown): ChatFailure {
  const e = error as { message?: unknown; code?: unknown } | null;
  const message = typeof e?.message === 'string' ? e.message : '';
  if (typeof e?.code === 'string' && CODE.test(e.code) && message) return { error: new ApiRequestError({ code: e.code, message, status: 0 }), answerAgain: true };
  const fromJson = fromJsonIn(message);
  if (fromJson) return { error: fromJson, answerAgain: false };
  console.error('chat turn failed without our error code', error);
  return { error: new ApiRequestError({ code: 'APP_CHAT_STREAM_INTERRUPTED', message: ru.chat.streamInterrupted, status: 0, cause: error }), answerAgain: false };
}
