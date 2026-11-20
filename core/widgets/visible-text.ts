// The words of a widget the person saw (spec, section 8.31): what the search finds (the same reading in SQL —
// app.widget_visible_text, migration 0031) and what the agent reads in an old conversation (core/history/transcript.ts).
// Texts, labels, titles, captions, the cells of a table, the items of lists, the titles of tabs, the options of a
// choice, the words of the data a screen shows; never ids, names of components, styles or codes of options.
import { operationsOf } from '@bba/contracts';

// Keys whose string is shown as it is.
export const WIDGET_TEXT_KEYS = ['text', 'label', 'title', 'caption', 'subtitle', 'description', 'meta', 'message', 'placeholder', 'snippet', 'source', 'emptyLabel'] as const;

const LISTS = ['items', 'options', 'columns'];

// `${…}` of a template is computed in the browser: its words are the rest of the template.
const TEMPLATE = /\$\{[^}]*\}/g;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const textOf = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null);

function collect(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, out);
    return;
  }
  if (!isObject(value)) return;
  for (const [key, inner] of Object.entries(value)) {
    if ((WIDGET_TEXT_KEYS as readonly string[]).includes(key) && typeof inner === 'string') {
      out.push(inner);
    } else if (key === 'rows' && Array.isArray(inner)) {
      // The cells of a table written as lists of rows.
      for (const row of inner) {
        if (!Array.isArray(row)) continue;
        for (const cell of row) {
          const text = textOf(cell);
          if (text !== null) out.push(text);
        }
      }
    } else if (key === 'args' && isObject(inner) && typeof inner.value === 'string') {
      // The value of a template (formatString).
      out.push(inner.value);
    } else if (LISTS.includes(key) && Array.isArray(inner)) {
      // Lists whose items may be plain strings: items of a list or of follow-ups, options of a choice, columns; the
      // value of a list item is shown on its right.
      for (const item of inner) {
        if (typeof item === 'string') out.push(item);
        else if (key === 'items' && isObject(item)) {
          const text = textOf(item.value);
          if (text !== null) out.push(text);
        }
      }
    }
    collect(inner, out);
  }
}

function strings(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (isObject(value)) for (const inner of Object.values(value)) strings(inner, out);
}

export function widgetVisibleText(args: unknown): string {
  const out: string[] = [];
  for (const op of operationsOf(args)) {
    const body = op.createSurface ?? op.updateComponents;
    if (isObject(body) && Array.isArray(body.components)) collect(body.components, out);
    if (isObject(op.createSurface) && op.createSurface.dataModel !== undefined) strings(op.createSurface.dataModel, out);
    if (isObject(op.updateDataModel)) strings(op.updateDataModel.value, out);
  }
  return out
    .map((s) => s.replace(TEMPLATE, ' ').replace(/\s+/g, ' ').trim())
    .filter((s) => s !== '')
    .join(' ');
}
