// Marks on a document in the viewer (spec, section 8.32): «Отправить агенту» sends one picture of the marks into a
// hidden folder of the conversation's working folder — not among the project's files, kept with them in a bucket —
// and a message that names it with the document among its attachments.
export const MARKS_FOLDER = '.marks';

// The model is given no bigger picture (core/sandbox/workspace.ts), so the browser makes none bigger.
export const MODEL_PICTURE_MAX_BYTES = 5 * 1024 * 1024;
