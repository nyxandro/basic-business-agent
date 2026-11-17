// Calls to /app/api. Every failure becomes ApiRequestError with the server's code and Russian
// text (spec, section 17.5); failures the server could not describe get a code of their own.
import { apiErrorSchema } from '@bba/contracts';
import { ru } from '../i18n/ru.ts';

export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly nextStep: string | undefined;

  constructor(input: { code: string; message: string; status: number; nextStep?: string; cause?: unknown }) {
    super(input.message, { cause: input.cause });
    this.name = 'ApiRequestError';
    this.code = input.code;
    this.status = input.status;
    this.nextStep = input.nextStep;
  }
}

export const SESSION_EXPIRED = 'APP_AUTH_SESSION_EXPIRED';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function toError(res: Response): Promise<ApiRequestError> {
  const raw: unknown = await res.json().catch(() => null);
  const parsed = apiErrorSchema.safeParse(raw);
  if (parsed.success) {
    const { code, message, nextStep } = parsed.data.error;
    return new ApiRequestError({ code, message, status: res.status, ...(nextStep ? { nextStep } : {}) });
  }
  return new ApiRequestError({ code: 'APP_SERVER_UNAVAILABLE', message: ru.clientErrors.APP_SERVER_UNAVAILABLE, status: res.status });
}

export async function api<T>(method: Method, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    throw new ApiRequestError({ code: 'APP_NETWORK_FAILED', message: ru.clientErrors.APP_NETWORK_FAILED, status: 0, cause: error });
  }
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

// Multipart upload (attachments, skills): the browser sets the boundary header itself. PUT replaces
// what is there (a new version of a skill).
export const apiFormPut = <T>(path: string, form: FormData): Promise<T> => apiForm<T>(path, form, 'PUT');

export async function apiForm<T>(path: string, form: FormData, method: 'POST' | 'PUT' = 'POST'): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { method, credentials: 'same-origin', body: form });
  } catch (error) {
    throw new ApiRequestError({ code: 'APP_NETWORK_FAILED', message: ru.clientErrors.APP_NETWORK_FAILED, status: 0, cause: error });
  }
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

// A multipart upload that tells how much of it has gone (attachments, spec 8.9): fetch cannot tell how
// much of a body is sent, XMLHttpRequest can. Failures are read as api() reads them.
export function apiFormWithProgress<T>(path: string, form: FormData, onProgress: (sent: number, total: number) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    };
    xhr.onerror = () => reject(new ApiRequestError({ code: 'APP_NETWORK_FAILED', message: ru.clientErrors.APP_NETWORK_FAILED, status: 0 }));
    xhr.onload = () => {
      const res = new Response(xhr.responseText, { status: xhr.status });
      if (!res.ok) {
        void toError(res).then(reject);
        return;
      }
      res.json().then((body) => resolve(body as T), reject);
    };
    xhr.send(form);
  });
}

export function asApiError(error: unknown): ApiRequestError {
  if (error instanceof ApiRequestError) return error;
  // Not a server answer but a failure inside the page: keep the details for diagnosis.
  console.error('unexpected client failure', error);
  return new ApiRequestError({ code: 'APP_SERVER_UNAVAILABLE', message: ru.clientErrors.APP_SERVER_UNAVAILABLE, status: 0, cause: error });
}
