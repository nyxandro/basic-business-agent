// Where to go after sign-in: only a path inside this site, so a crafted link cannot send the
// person to another site right after they enter their password.
const BASE = 'http://bba.invalid';
const FIRST_PRINTABLE = 0x20;
const DELETE = 0x7f;

// Browsers drop tabs and line breaks from addresses ("/\t/evil" turns into "//evil") and treat a
// backslash like a slash; such paths are refused before they are resolved.
function hasUnsafeCharacter(path: string): boolean {
  return [...path].some((ch) => {
    const code = ch.charCodeAt(0);
    return code < FIRST_PRINTABLE || code === DELETE || ch === '\\' || /\s/.test(ch);
  });
}

export function safeNextPath(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || hasUnsafeCharacter(raw)) return '/';
  const url = new URL(raw, BASE);
  if (url.origin !== BASE) return '/';
  return `${url.pathname}${url.search}${url.hash}`;
}
