// The text a person sees of an agent's answer in the chat. The chat draws answers with CopilotKit's
// own parser (@copilotkit/markdown under StreamingMarkdownDefaultRenderer of @copilotkit/react-core,
// default options); this builds the same render tree and keeps its text, so «Поиск» shows the words
// of the chat: no stars, hashes or pipes, footnotes as numbers, raw HTML and entities as typed. The
// package is pinned to the version react-core depends on (visible-text.test.ts checks).
import { buildStreamingMarkdownRenderTree, createStreamingMarkdownParserState, finalizeStreamingMarkdown, parseStreamingMarkdownChunk, type StreamingMarkdownRenderChild } from '@copilotkit/markdown';

// Elements the chat draws on a line of their own: a space between them.
const BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'table', 'tbody', 'tr', 'td', 'th', 'hr', 'br']);
// Characters the renderer puts in that take no room on the screen (a word joiner after a footnote).
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;

// A node draws its `output`, where each slot stands for its `children`.
function collect(child: StreamingMarkdownRenderChild, slot: StreamingMarkdownRenderChild[] | null, out: string[]): void {
  switch (child.kind) {
    case 'text':
      out.push(child.text);
      return;
    case 'slot':
      for (const inner of slot ?? []) collect(inner, null, out);
      return;
    case 'element':
      for (const inner of child.children) collect(inner, slot, out);
      if (BLOCKS.has(child.tag)) out.push(' ');
      return;
    case 'node':
      for (const inner of child.output) collect(inner, child.children, out);
      return;
    case 'caret':
      return;
  }
}

export function visibleText(markdown: string): string {
  // Segmenting splits words for the typing animation only: the text is the same without it.
  const state = finalizeStreamingMarkdown(parseStreamingMarkdownChunk(createStreamingMarkdownParserState({ segmenter: false }), markdown));
  const { root } = buildStreamingMarkdownRenderTree(state, { caret: false });
  const out: string[] = [];
  if (root) collect(root, null, out);
  return out.join('').replace(ZERO_WIDTH, '').replace(/\s+/g, ' ').trim();
}
