// The text a person sees of an agent's answer: the chat draws answers as Markdown with GFM (tables,
// strikethrough, task lists, footnotes), so a piece of the stored text showed stars, hashes and
// pipes in «Поиск». Blocks — paragraphs, headings, list items, table cells — are split by a space.
import type { Nodes } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';

const PARSE = { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] };

// Nodes inside a line of text; any other node is a block and ends with a space.
const INLINE = new Set<Nodes['type']>(['text', 'emphasis', 'strong', 'delete', 'inlineCode', 'link', 'linkReference', 'break', 'html', 'image', 'imageReference', 'footnoteReference']);

function collect(node: Nodes, out: string[]): void {
  switch (node.type) {
    case 'text':
    case 'inlineCode':
    case 'code':
      out.push(node.value);
      break;
    case 'image':
    case 'imageReference':
      out.push(node.alt ?? '');
      break;
    case 'break':
      out.push(' ');
      break;
    // Not shown as text: raw HTML tags, link definitions, footnote numbers.
    case 'html':
    case 'definition':
    case 'footnoteReference':
      break;
    default:
      if ('children' in node) for (const child of node.children) collect(child, out);
  }
  if (!INLINE.has(node.type)) out.push(' ');
}

export function visibleText(markdown: string): string {
  const out: string[] = [];
  collect(fromMarkdown(markdown, PARSE), out);
  return out.join('').replace(/\s+/g, ' ').trim();
}
