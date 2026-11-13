import { fileURLToPath } from 'node:url';
import { checkBoundaries } from './check.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const violations = checkBoundaries(root);

if (violations.length > 0) {
  for (const v of violations) console.error(`${v.file}:${v.line} imports "${v.specifier}": ${v.reason}`);
  console.error(`APP_ARCH_BOUNDARY_VIOLATION: ${violations.length} forbidden import(s). Move the code or import the public part instead.`);
  process.exit(1);
}
console.log('Import boundaries OK');
