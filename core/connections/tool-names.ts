// Names of the actions of an MCP server as the model sees them (docs/specs/[20.11.2026]-mcp-connections.md,
// section 8). Providers take only `^[a-zA-Z0-9_-]{1,64}$` and reject the whole request of the agent over one bad
// name, while servers name actions as they like (`crm.deal.list`, Cyrillic). The name is
// `<slug>_<server's name, other symbols → _>`; a name longer than 64, or one that coincides with another after the
// replacement, is cut and ends with 6 symbols of a fingerprint of the server's full name. The server's own name
// stays in the snapshot: rules of approvals refer to it.
import { createHash } from 'node:crypto';
import { appError } from '../errors/catalog.ts';

const MAX_LENGTH = 64;
const FINGERPRINT_LENGTH = 6;
const NOT_ALLOWED = /[^a-zA-Z0-9_-]/g;

const fingerprint = (name: string) => createHash('sha256').update(name).digest('hex').slice(0, FINGERPRINT_LENGTH);

// The same names for the same set of server names, in any order.
export function modelNames(slug: string, names: readonly string[]): Map<string, string> {
  const plain = new Map(names.map((name) => [name, `${slug}_${name.replace(NOT_ALLOWED, '_')}`]));
  const uses = new Map<string, number>();
  for (const candidate of plain.values()) uses.set(candidate, (uses.get(candidate) ?? 0) + 1);

  const out = new Map<string, string>();
  for (const [name, candidate] of plain) {
    const unique = uses.get(candidate) === 1 && candidate.length <= MAX_LENGTH;
    out.set(name, unique ? candidate : `${candidate.slice(0, MAX_LENGTH - FINGERPRINT_LENGTH - 1)}_${fingerprint(name)}`);
  }
  // A cut name may still meet a server name written exactly like it, or two fingerprints may agree: the snapshot
  // is refused rather than one action quietly shadowing another.
  if (new Set(out.values()).size !== out.size) throw appError('APP_INTERNAL', `two actions of the MCP server ${slug} got one name for the model`);
  return out;
}
