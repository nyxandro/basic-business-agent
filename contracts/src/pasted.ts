// A long text pasted into the input (request of the owner 25.11): a part of the message the model reads as it is — no file
// (the agent should not have to remember a text was in a file) — standing after the person's words between two lines of
// its own; the chat folds it in the input and in the bubble. The block of attachments (withAttachments) comes after it.
export const PASTED_START = '--- Вставленный текст ---';
export const PASTED_END = '--- Конец вставленного текста ---';

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A pasted text is the lines between the two, the first after the words or another pasted text with a blank line between.
const BLOCK = new RegExp(`(^|\\n\\n)${escape(PASTED_START)}\\n([\\s\\S]*?)\\n${escape(PASTED_END)}(?=\\n\\n|$)`, 'g');

export function withPasted(text: string, pieces: readonly string[]): string {
  if (pieces.length === 0) return text;
  const blocks = pieces.map((piece) => `${PASTED_START}\n${piece}\n${PASTED_END}`);
  return [...(text === '' ? [] : [text]), ...blocks].join('\n\n');
}

// The person's words and the pasted texts of a message, apart.
export function splitPasted(message: string): { text: string; pieces: string[] } {
  const pieces: string[] = [];
  const text = message.replace(BLOCK, (_whole: string, _before: string, piece: string) => {
    pieces.push(piece);
    return '';
  });
  return { text, pieces };
}
