// Where to go after sign-in: only a path inside this site, so a crafted link cannot send the
// person to another site right after they enter their password.
export function safeNextPath(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  return raw;
}
