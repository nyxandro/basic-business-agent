// Viewing documents in place (spec, section 8.27; decisions of the owner 18.11): which files the viewer
// shows and how. Word, Excel and PowerPoint the server turns into PDF with LibreOffice; PDF, text,
// Markdown and pictures the browser shows as they are. Anything else only downloads.
export const PREVIEW_KINDS = ['document', 'sheet', 'presentation', 'pdf', 'text', 'markdown', 'image'] as const;
export type PreviewKind = (typeof PREVIEW_KINDS)[number];

const EXTENSIONS: Record<PreviewKind, readonly string[]> = {
  document: ['.docx', '.doc', '.docm', '.dotx', '.dot', '.odt', '.rtf'],
  sheet: ['.xlsx', '.xlsm', '.xls', '.ods'],
  presentation: ['.pptx', '.ppt', '.ppsx', '.pps', '.odp'],
  pdf: ['.pdf'],
  text: ['.txt', '.csv', '.log', '.json', '.xml', '.yaml', '.yml', '.ini', '.sql', '.js', '.ts', '.py', '.sh', '.css', '.html'],
  markdown: ['.md', '.markdown'],
  image: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'],
};

const KIND_OF = new Map(Object.entries(EXTENSIONS).flatMap(([kind, list]) => list.map((ext) => [ext, kind as PreviewKind] as const)));

// The kind of a file by the extension of its name, regardless of case; null — the file only downloads.
export function previewKindOf(name: string): PreviewKind | null {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot < name.lastIndexOf('/')) return null;
  return KIND_OF.get(name.slice(dot).toLowerCase()) ?? null;
}

// What the server turns into PDF before showing (GET …/file/preview).
export const CONVERTED_KINDS: ReadonlySet<PreviewKind> = new Set(['document', 'sheet', 'presentation']);

// A file bigger than this is not shown: the server does not convert it, the browser stops reading it.
export const PREVIEW_MAX_BYTES = 50 * 1024 * 1024;
// Of a text file, the viewer shows this much — the beginning — and says so.
export const PREVIEW_TEXT_MAX_BYTES = 1024 * 1024;
