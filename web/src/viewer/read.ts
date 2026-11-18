// A file for the viewer read by the browser (spec, section 8.27): never more than the limit — a phone does
// not download a 300 MB log to show its first page. A refusal of the server comes as its code and text.
import { ApiRequestError, toError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';

export async function readCapped(url: string, limit: number, signal: AbortSignal): Promise<{ bytes: Uint8Array; cut: boolean }> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ApiRequestError({ code: 'APP_NETWORK_FAILED', message: ru.clientErrors.APP_NETWORK_FAILED, status: 0, cause: error });
  }
  if (!res.ok) throw await toError(res);
  if (!res.body) {
    const whole = new Uint8Array(await res.arrayBuffer());
    return { bytes: whole.subarray(0, limit), cut: whole.length > limit };
  }
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    size += value.length;
    // A byte over the limit tells the file goes on; one exactly the limit is whole.
    if (size > limit) {
      cut = true;
      await reader.cancel();
      break;
    }
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  return { bytes: cut ? all.subarray(0, limit) : all, cut };
}

// The type of a picture by its name: the server gives some of them as `application/octet-stream`.
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
};

export function imageType(name: string): string {
  const dot = name.lastIndexOf('.');
  const type = IMAGE_TYPES[name.slice(dot).toLowerCase()];
  if (!type) throw new Error(`${name} is not a picture of the viewer`);
  return type;
}
