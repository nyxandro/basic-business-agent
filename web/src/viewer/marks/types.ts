// A mark on a page of a document in the viewer (spec, section 8.32): drawn with one of the four tools, or selected
// text — made by itself when text is selected while «Пометки» is on (request of the owner 20.11), no tool for it.
export const MARK_TOOLS = ['rect', 'ellipse', 'pen', 'arrow'] as const;
export type MarkTool = (typeof MARK_TOOLS)[number];
export type MarkKind = MarkTool | 'highlight';

// A place on a page as shares of the page as it is shown: 0 — its left or top edge, 1 — its right or bottom one.
// The same mark lies on the screen at any scale and on the picture for the agent.
export interface Point {
  x: number;
  y: number;
}

export interface Mark {
  id: string;
  // The page, from 1; a picture is page 1.
  page: number;
  tool: MarkKind;
  // A rectangle, an oval and an arrow — where the drawing began and where it ended (an arrow points at the end);
  // the pen — the whole line; selected text — the corners of the box of each of its lines, two points a line.
  points: Point[];
  comment: string;
  // Selected text: the text itself, as it was selected.
  text?: string;
}

// The longest comment: the message stays readable (spec, section 8.32).
export const COMMENT_MAX = 2000;

// The file the marks are drawn on, opened from a file block of the chat (F43): its conversation, its path in the
// conversation's folder and the version it had when opened (`version` of its status).
export interface MarksTarget {
  threadId: string;
  path: string;
  version: string;
}

// How the marks reach the agent: the chat's own sending (web/src/answer/chat-send.ts); false — nothing was sent.
export interface MarksChannel {
  send: (text: string) => boolean;
  running: boolean;
}

// What the view of the document (pages of a PDF or a picture) does for the marks.
export interface MarksDocument {
  // The text under a mark; empty on a scan or a picture.
  quote: (mark: Mark) => Promise<string>;
  // The picture of the marks for the agent (picture.ts).
  picture: (marks: readonly Mark[]) => Promise<Blob>;
  // Scrolls the mark into view.
  reveal: (mark: Mark) => void;
}

// A page as the layer of marks lies over it, in points of the scrolled content of the view.
export interface PageBox {
  page: number;
  left: number;
  top: number;
  width: number;
  height: number;
}
