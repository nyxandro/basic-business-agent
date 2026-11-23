import { fileURLToPath } from 'node:url';
import { checkArchitecture } from './check.ts';
import { architectureRules, MUTUAL_MODULES_COMMENT, MUTUAL_MODULES_RULE } from './rules.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const violations = await checkArchitecture(root);

if (violations.length > 0) {
  const why = new Map(architectureRules(root).map((r) => [r.name, r.comment]));
  why.set(MUTUAL_MODULES_RULE, MUTUAL_MODULES_COMMENT);
  for (const v of violations) console.error(`${v.rule}: ${v.from} -> ${v.to}${v.detail ? `\n    ${v.detail}` : ''}`);
  console.error('\nWhy and what to do:');
  for (const rule of new Set(violations.map((v) => v.rule))) console.error(`- ${rule}: ${why.get(rule) ?? ''}`);
  console.error(`APP_ARCH_BOUNDARY_VIOLATION: ${violations.length} architecture violation(s).`);
  process.exit(1);
}
console.log('Architecture OK');
