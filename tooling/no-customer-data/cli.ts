// Usage:
//   node tooling/no-customer-data/cli.ts             — scan the whole history of HEAD
//   node tooling/no-customer-data/cli.ts --pre-push  — scan only the commits being pushed (git pre-push hook)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectFindings, loadForbiddenWords, rangesFromPrePush, type Finding } from './check.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
// Local and git-ignored: the names themselves must never reach the public repository.
const WORDS_FILE = join(root, '.public-check', 'forbidden-words.txt');

function describe(f: Finding): string {
  const where = f.where === 'message' ? 'commit message' : `${f.file ?? ''}${f.line ? `:${f.line}` : ''}`;
  const what = f.word ? `contains "${f.word}"` : 'is under inbox/';
  return `${f.commit.slice(0, 8)} ${where} ${what}`;
}

try {
  const words = loadForbiddenWords(WORDS_FILE);
  const ranges = process.argv.includes('--pre-push') ? rangesFromPrePush(readFileSync(0, 'utf8')) : [['HEAD']];
  const findings = ranges.flatMap((range) => collectFindings(root, range, words));
  if (findings.length > 0) {
    for (const f of findings) console.error(describe(f));
    console.error(
      `APP_PUBLIC_CHECK_FAILED: ${findings.length} finding(s) of customer data in commits about to be published. ` +
        'Rewrite those commits locally to remove the data, then push again.',
    );
    process.exit(1);
  }
  console.log('No customer data in the checked commits');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
