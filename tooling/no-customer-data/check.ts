// "No customer data" check for the public repository (spec, step 1).
// It scans every commit about to leave the machine, not only the latest files:
// anything that once reached a pushed commit stays in the public history.
// Flagged: a forbidden word in an added line, a commit message or a file path,
// and any file under inbox/ (customer materials live there and are never published).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

export interface Finding {
  commit: string;
  where: 'content' | 'message' | 'path';
  file?: string;
  line?: number;
  word?: string;
}

const COMMIT_MARK = '__COMMIT__ ';
const MESSAGE_END = '__MESSAGE_END__';
const LOG_FORMAT = `--format=${COMMIT_MARK}%H%n%B%n${MESSAGE_END}`;
const ZERO_SHA = /^0+$/;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const BINARY_TARGET = / and b\/(.+) differ$/;
const INBOX_PREFIX = 'inbox/';
const GIT_LOG_MAX_BUFFER = 1024 * 1024 * 1024;

export function parseForbiddenWords(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
    .map((l) => l.toLowerCase());
}

export function loadForbiddenWords(path: string): string[] {
  if (!existsSync(path)) {
    throw new Error(
      `APP_PUBLIC_CHECK_WORDS_MISSING: the local list of forbidden words is missing (${path}). ` +
        'Create it with one customer name per line; an empty file is a deliberate "nothing to hide".',
    );
  }
  return parseForbiddenWords(readFileSync(path, 'utf8'));
}

function wordsIn(text: string, words: string[]): string[] {
  const lower = text.toLowerCase();
  return words.filter((w) => lower.includes(w));
}

export function scanGitLog(log: string, words: string[]): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const add = (f: Finding) => {
    const key = JSON.stringify(f);
    if (!seen.has(key)) {
      seen.add(key);
      findings.push(f);
    }
  };

  let commit = '';
  let inMessage = false;
  let inHunk = false;
  let file: string | null = null;
  let newLine = 0;

  const checkPath = (path: string) => {
    if (path.startsWith(INBOX_PREFIX)) add({ commit, where: 'path', file: path });
    for (const word of wordsIn(path, words)) add({ commit, where: 'path', file: path, word });
  };

  for (const line of log.split('\n')) {
    if (line.startsWith(COMMIT_MARK)) {
      commit = line.slice(COMMIT_MARK.length).trim();
      inMessage = true;
      inHunk = false;
      file = null;
      continue;
    }
    if (inMessage) {
      if (line === MESSAGE_END) inMessage = false;
      else for (const word of wordsIn(line, words)) add({ commit, where: 'message', word });
      continue;
    }
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      file = null;
      continue;
    }
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      inHunk = true;
      newLine = Number(hunk[1]);
      continue;
    }
    if (inHunk) {
      if (line.startsWith('+')) {
        if (file) for (const word of wordsIn(line.slice(1), words)) add({ commit, where: 'content', file, line: newLine, word });
        newLine++;
      } else if (line.startsWith(' ')) {
        newLine++;
      }
      continue;
    }
    if (line.startsWith('+++ ')) {
      const target = line.slice(4);
      file = target === '/dev/null' ? null : target.replace(/^b\//, '');
      if (file) checkPath(file);
    } else if (line.startsWith('rename to ')) {
      file = line.slice('rename to '.length);
      checkPath(file);
    } else if (line.startsWith('Binary files ')) {
      const binary = BINARY_TARGET.exec(line);
      if (binary?.[1]) checkPath(binary[1]);
    }
  }
  return findings;
}

// git passes "<local ref> <local sha> <remote ref> <remote sha>" per pushed ref on stdin.
export function rangesFromPrePush(stdin: string): string[][] {
  const ranges: string[][] = [];
  for (const raw of stdin.split('\n')) {
    const [, localSha, , remoteSha] = raw.trim().split(/\s+/);
    if (!localSha || !remoteSha || ZERO_SHA.test(localSha)) continue;
    ranges.push(ZERO_SHA.test(remoteSha) ? [localSha, '--not', '--remotes'] : [`${remoteSha}..${localSha}`]);
  }
  return ranges;
}

export function collectFindings(repoDir: string, range: string[], words: string[]): Finding[] {
  const log = execFileSync(
    'git',
    ['-c', 'core.quotePath=false', 'log', '-p', '--no-color', '--no-ext-diff', LOG_FORMAT, ...range],
    { cwd: repoDir, encoding: 'utf8', maxBuffer: GIT_LOG_MAX_BUFFER },
  );
  return scanGitLog(log, words);
}
