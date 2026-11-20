// The message «Отправить агенту» sends (spec, section 8.32): an ordinary message of the person, seen in the chat
// whole — the marks by number with the page, the shape, the comment and the text under each; the document and the
// picture of the marks among its attachments, so the model gets the text of the document (8.29) and the picture.
import { withAttachments, type AttachedFile } from '@bba/contracts';
import { ru } from '../../i18n/ru.ts';
import type { MarkTool } from './types.ts';

export interface MarkInMessage {
  tool: MarkTool;
  page: number;
  comment: string;
  // The text under the mark (text-under.ts); empty on a scan or a picture.
  quote: string;
}

// The lines after the first of a comment, and the quote, stand under the number of their mark.
const INDENT = '   ';

export function marksMessage(input: { document: AttachedFile; picture: AttachedFile; paged: boolean; marks: readonly MarkInMessage[] }): string {
  const t = ru.marks.message;
  const { document, picture, paged, marks } = input;
  const lines = [paged ? t.document(document.name, marks.length) : t.picture(document.name, marks.length)];
  marks.forEach((mark, i) => {
    const shape = paged ? `${t.page(mark.page)}, ${t.tool(mark.tool)}` : t.toolFirst(mark.tool);
    const comment = mark.comment
      .trim()
      .split('\n')
      .map((line) => line.trimEnd());
    const said = comment[0] ? `: ${comment.join(`\n${INDENT}`)}` : ` — ${t.noComment}`;
    lines.push(`${i + 1}. ${shape}${said}`);
    if (mark.quote) lines.push(`${INDENT}${mark.tool === 'arrow' ? t.atArrow : t.under}: «${mark.quote}»`);
  });
  return withAttachments(lines.join('\n'), [document, picture]);
}
