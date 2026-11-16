// A text of a search result with what the search found in it marked (spec, section 8.21): the server says
// where — it alone knows the variants a word was found by (another form, Latin, a typo). A mark that does
// not fit the text is left out: the text itself is always drawn whole.
import type { TextMarks } from '@bba/contracts';
import styles from './search.module.css';

export function Marked({ text, marks }: { text: string; marks?: TextMarks | undefined }) {
  if (!marks || marks.length === 0) return text;
  const parts: (string | { mark: string })[] = [];
  let at = 0;
  for (const [from, to] of marks) {
    if (from < at || to <= from || to > text.length) continue;
    if (from > at) parts.push(text.slice(at, from));
    parts.push({ mark: text.slice(from, to) });
    at = to;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts.map((part, i) =>
    typeof part === 'string' ? (
      part
    ) : (
      <mark key={i} className={styles.mark}>
        {part.mark}
      </mark>
    ),
  );
}
