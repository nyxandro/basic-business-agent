import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectFindings, loadForbiddenWords, parseForbiddenWords, rangesFromPrePush, scanGitLog } from './check.ts';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const ZERO = '0'.repeat(40);

function commit(sha: string, message: string, patch: string): string {
  return `__COMMIT__ ${sha}\n${message}\n__MESSAGE_END__\n${patch}`;
}

const patchAdding = (path: string, lines: string[]) =>
  [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
  ].join('\n');

describe('parseForbiddenWords', () => {
  it('skips blank lines and comments, trims and lowercases', () => {
    expect(parseForbiddenWords('# customers\n  Альфа-Строй \n\nACME Corp\n# end\n')).toEqual(['альфа-строй', 'acme corp']);
  });
});

describe('scanGitLog', () => {
  it('flags an added line with a forbidden word, case-insensitively, with file and line', () => {
    const log = commit(SHA_A, 'Добавить заметки', patchAdding('docs/notes.md', ['Первая строка', 'Встреча с ACME CORP в понедельник']));
    expect(scanGitLog(log, ['acme corp'])).toEqual([
      { commit: SHA_A, where: 'content', file: 'docs/notes.md', line: 2, word: 'acme corp' },
    ]);
  });

  it('ignores removed and unchanged lines: removal does not add data to the history', () => {
    const patch = [
      'diff --git a/docs/notes.md b/docs/notes.md',
      '--- a/docs/notes.md',
      '+++ b/docs/notes.md',
      '@@ -1,2 +1,1 @@',
      ' ACME Corp context line',
      '-ACME Corp removed line',
    ].join('\n');
    expect(scanGitLog(commit(SHA_A, 'Убрать', patch), ['acme corp'])).toEqual([]);
  });

  it('counts line numbers from the hunk header', () => {
    const patch = [
      'diff --git a/a.md b/a.md',
      '--- a/a.md',
      '+++ b/a.md',
      '@@ -10,3 +10,4 @@',
      ' context',
      '+added ACME Corp',
      ' context',
    ].join('\n');
    expect(scanGitLog(commit(SHA_A, 'x', patch), ['acme corp'])[0]?.line).toBe(11);
  });

  it('flags a forbidden word in the commit message', () => {
    expect(scanGitLog(commit(SHA_A, 'Шаблон для ACME Corp', ''), ['acme corp'])).toEqual([
      { commit: SHA_A, where: 'message', word: 'acme corp' },
    ]);
  });

  it('flags any file under inbox/, text or binary', () => {
    const binary = [
      'diff --git a/inbox/alpha/brief.pdf b/inbox/alpha/brief.pdf',
      'new file mode 100644',
      'Binary files /dev/null and b/inbox/alpha/brief.pdf differ',
    ].join('\n');
    const log = commit(SHA_A, 'x', patchAdding('inbox/README.md', ['опись'])) + '\n' + commit(SHA_B, 'y', binary);
    expect(scanGitLog(log, [])).toEqual([
      { commit: SHA_A, where: 'path', file: 'inbox/README.md' },
      { commit: SHA_B, where: 'path', file: 'inbox/alpha/brief.pdf' },
    ]);
  });

  it('flags a forbidden word in a file path, including a rename target', () => {
    const rename = ['diff --git a/a.md b/acme-corp.md', 'similarity index 100%', 'rename from a.md', 'rename to acme-corp.md'].join('\n');
    expect(scanGitLog(commit(SHA_A, 'x', rename), ['acme-corp'])).toEqual([
      { commit: SHA_A, where: 'path', file: 'acme-corp.md', word: 'acme-corp' },
    ]);
  });

  it('returns nothing for a clean history', () => {
    expect(scanGitLog(commit(SHA_A, 'Каркас', patchAdding('core/a.ts', ['export const a = 1;'])), ['acme corp'])).toEqual([]);
  });
});

describe('rangesFromPrePush', () => {
  it('builds a range for an updated branch and for a new branch, skips deletions', () => {
    const stdin = [
      `refs/heads/main ${SHA_B} refs/heads/main ${SHA_A}`,
      `refs/heads/feature ${SHA_B} refs/heads/feature ${ZERO}`,
      `(delete) ${ZERO} refs/heads/old ${SHA_A}`,
    ].join('\n');
    expect(rangesFromPrePush(stdin)).toEqual([[`${SHA_A}..${SHA_B}`], [SHA_B, '--not', '--remotes']]);
  });
});

describe('loadForbiddenWords', () => {
  it('fails with an explicit code when the local list is missing', () => {
    expect(() => loadForbiddenWords('/nonexistent/forbidden-words.txt')).toThrow(/APP_PUBLIC_CHECK_WORDS_MISSING/);
  });
});

describe('collectFindings on a real git repository', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function git(args: string[]): string {
    return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8' });
  }
  function write(path: string, content: string): void {
    const full = join(dir!, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  it('finds a word that was added in one commit and removed in the next', () => {
    dir = mkdtempSync(join(tmpdir(), 'bba-public-'));
    git(['init', '-q']);
    write('notes.md', 'Планы на неделю\nПозвонить в ACME Corp\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'Заметки']);
    write('notes.md', 'Планы на неделю\n');
    git(['commit', '-q', '-am', 'Убрать лишнее']);
    const findings = collectFindings(dir, ['HEAD'], ['acme corp']);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ where: 'content', file: 'notes.md', line: 2, word: 'acme corp' });
  });
});
