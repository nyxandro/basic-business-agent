// A program server inside bubblewrap in the mcp-runner container (docs/specs/[20.11.2026]-mcp-connections.md, F1):
// the network of the container (the internet and the office; the container itself is outside the networks of the
// database and the gateway), the system's programs read-only, its own package folder read-only, an empty /tmp —
// and no other files, no environment but the admin's, its own processes only.
import { existsSync } from 'node:fs';

// System folders a program needs to run and to reach a server by https; absent ones are skipped.
const SYSTEM_PATHS = ['/usr', '/bin', '/lib', '/lib64', '/etc/ssl', '/etc/ca-certificates', '/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf'];
const PATH = '/usr/local/bin:/usr/bin:/bin';

export interface Launch {
  // What to run, with absolute paths: the package folder is mounted at its own path.
  command: string;
  args: string[];
  // The package folder (read-only inside).
  root: string;
  // Folders besides the system ones the command needs (the folder of Node itself when it lives elsewhere).
  extraPaths: string[];
}

export function sandboxed(launch: Launch, env: Record<string, string>, bwrap: string): { command: string; args: string[] } {
  const binds = [...SYSTEM_PATHS, ...launch.extraPaths].filter((path) => existsSync(path)).flatMap((path) => ['--ro-bind', path, path]);
  const vars = Object.entries({ ...env, PATH, HOME: '/tmp' }).flatMap(([name, value]) => ['--setenv', name, value]);
  return {
    command: bwrap,
    // The empty /tmp first: a package folder under /tmp (as in tests) is mounted over it, not hidden by it.
    args: ['--unshare-all', '--share-net', '--die-with-parent', '--new-session', '--clearenv', ...vars, '--tmpfs', '/tmp', '--proc', '/proc', '--dev', '/dev', ...binds, '--ro-bind', launch.root, launch.root, '--chdir', '/tmp', '--', launch.command, ...launch.args],
  };
}
