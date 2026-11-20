// A mark on a page of a document in the viewer (spec, section 8.32).
export const MARK_TOOLS = ['rect', 'ellipse', 'pen', 'arrow'] as const;
export type MarkTool = (typeof MARK_TOOLS)[number];

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
  tool: MarkTool;
  // A rectangle, an oval and an arrow — where the drawing began and where it ended (an arrow points at the end);
  // the pen — the whole line.
  points: Point[];
  comment: string;
}

// The longest comment: the message stays readable (spec, section 8.32).
export const COMMENT_MAX = 2000;
