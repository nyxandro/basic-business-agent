// Text files in the viewer (spec, section 8.27): the encoding as a person's tools write it — UTF-8, the
// Windows-1251 of Russian Excel, UTF-16 by its mark — and Markdown that never makes the browser fetch a
// picture from the internet (the data of the person would go with it: the rule «the browser talks only
// to the installation»).
import { ru } from '../i18n/ru.ts';

const UTF8_MARK = [0xef, 0xbb, 0xbf];

function startsWith(bytes: Uint8Array, mark: number[]): boolean {
  return mark.every((b, i) => bytes[i] === b);
}

// `cut`: the file was read only up to the limit, so its last letter may be broken off.
export function decodeText(bytes: Uint8Array, cut: boolean): string {
  if (startsWith(bytes, [0xff, 0xfe])) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (startsWith(bytes, [0xfe, 0xff])) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const body = startsWith(bytes, UTF8_MARK) ? bytes.subarray(UTF8_MARK.length) : bytes;
  const strict = new TextDecoder('utf-8', { fatal: true });
  // A letter of UTF-8 is up to 4 bytes: a cut file may end with up to 3 of a broken one.
  for (let drop = 0; drop <= (cut ? 3 : 0) && drop <= body.length; drop++) {
    try {
      return strict.decode(body.subarray(0, body.length - drop));
    } catch {
      // Not UTF-8 this way: try without one more byte, then as Windows-1251.
    }
  }
  return new TextDecoder('windows-1251').decode(body);
}

export function safeMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\((https?:[^)\s]*)[^)]*\)/gi, (_all, alt: string, url: string) => `[${ru.viewer.externalImage(alt)}](${url})`)
    .replace(/<img\b[^>]*\bsrc\s*=\s*["']?https?:[^>]*>/gi, ru.viewer.externalImage(''));
}
