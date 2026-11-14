// Builds deploy/seccomp-bwrap.json from Docker's default seccomp profile (spec, section 8.9):
// bubblewrap creates the isolation of skill scripts with user namespaces, which the default profile
// allows only with CAP_SYS_ADMIN. The container gets no extra capabilities; instead exactly these
// 7 system calls are allowed without conditions. Everything else stays as Docker has it.
//
//   node tooling/seccomp/build-profile.ts <docker default.json> deploy/seccomp-bwrap.json
//
// The default profile of a Docker version lives in moby/moby at the tag docker-v<version>:
// vendor/github.com/moby/profiles/seccomp/default.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BWRAP_SYSCALLS = ['unshare', 'clone', 'clone3', 'setns', 'mount', 'umount2', 'pivot_root'];

interface Rule {
  names: string[];
  action: string;
  [key: string]: unknown;
}

export function buildProfile(base: { syscalls: Rule[]; [key: string]: unknown }): { syscalls: Rule[]; [key: string]: unknown } {
  // Conditional rules for these calls (by capability or by clone flags) would clash with the
  // unconditional one, so the calls leave them first.
  const syscalls: Rule[] = base.syscalls
    .map((rule) => ({ ...rule, names: rule.names.filter((n) => !BWRAP_SYSCALLS.includes(n)) }))
    .filter((rule) => rule.names.length > 0);
  syscalls.push({ names: BWRAP_SYSCALLS, action: 'SCMP_ACT_ALLOW', comment: 'bubblewrap isolation of skill scripts (basic-business-agent)' });
  return { ...base, syscalls };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('usage: build-profile.ts <docker default.json> <output.json>');
  const profile = buildProfile(JSON.parse(readFileSync(input, 'utf8')) as { syscalls: Rule[] });
  writeFileSync(output, `${JSON.stringify(profile, null, 2)}\n`);
  console.log(`Written ${output}`);
}
