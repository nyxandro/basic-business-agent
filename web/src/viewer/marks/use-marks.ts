// The marks of one open document (spec, section 8.32): what is drawn, the tool, the mark whose window is open, the
// draft in this browser (F44) and «Отправить агенту». The view of the document gives what only it can (MarksDocument):
// the text under a mark, the picture for the agent, scrolling to a mark.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ApiRequestError, asApiError } from '../../api/client.ts';
import { ru } from '../../i18n/ru.ts';
import { uploadMarksPicture } from './api.ts';
import { draftKey, readStoredDraft, storeDraft } from './draft.ts';
import { marksMessage } from './message.ts';
import type { Mark, MarkKind, MarkTool, MarksChannel, MarksDocument, MarksTarget, Point } from './types.ts';

export interface MarksSession extends MarksTarget, MarksChannel {
  // The name of the document, as the chat shows it.
  name: string;
  // Pages of a PDF (Word, Excel, PowerPoint through PDF) — or one picture.
  paged: boolean;
}

export type MarksNotice = 'changed' | 'noStorage';

export interface MarksController {
  // Saved marks: each with its comment, in the list and in the browser.
  marks: readonly Mark[];
  // The mark just drawn, before its comment and «Готово» (owner, 20.11): on the page with its window, not in the list,
  // not kept; gone when its window closes without «Готово» or the next mark begins.
  pending: Mark | null;
  paged: boolean;
  // «Пометки» pressed: the tools and the list are shown, the marks answer a press.
  active: boolean;
  tool: MarkTool | null;
  selected: string | null;
  notice: MarksNotice | null;
  sending: boolean;
  running: boolean;
  error: ApiRequestError | null;
  toggle: () => void;
  setTool: (tool: MarkTool | null) => void;
  // A new mark opens its window; the tool is let go — one figure a choice of the tool (owner, 20.11).
  add: (mark: { page: number; tool: MarkKind; points: Point[]; text?: string }) => void;
  // «Готово»: the comment, never empty, is saved — a new mark goes into the list with it.
  save: (id: string, comment: string) => void;
  remove: (id: string) => void;
  // Opens the window of a mark, or closes it (null); a mark not saved goes with its window.
  select: (id: string | null) => void;
  // Scrolls to a mark and opens its window.
  open: (id: string) => void;
  // The view of the document says what it can do; null when it closes. The same function for the whole viewer.
  attach: (document: MarksDocument | null) => void;
  send: () => Promise<void>;
  // Esc closes the window of a mark, then lets the tool go; true — it did, the viewer stays open.
  escape: () => boolean;
}

export const MarksContext = createContext<MarksController | null>(null);
export const useMarks = (): MarksController | null => useContext(MarksContext);

interface Initial {
  marks: Mark[];
  notice: MarksNotice | null;
}

// The draft of this version of the file; a draft of another version is removed and the person is told.
function initial(session: MarksSession | null): Initial {
  if (!session) return { marks: [], notice: null };
  const key = draftKey(session.threadId, session.path);
  const stored = readStoredDraft(key);
  if (stored.state === 'unavailable') return { marks: [], notice: 'noStorage' };
  if (stored.state === 'none') return { marks: [], notice: null };
  if (stored.draft.version === session.version) return { marks: stored.draft.marks, notice: null };
  storeDraft(key, null);
  return { marks: [], notice: 'changed' };
}

export function useMarksController(session: MarksSession | null, onSent: () => void): MarksController | null {
  const [start] = useState(() => initial(session));
  const [marks, setMarks] = useState<Mark[]>(start.marks);
  // Open by themselves when there are unsent marks — or when they were removed: not without a word.
  const [active, setActive] = useState(start.marks.length > 0 || start.notice === 'changed');
  const [tool, setTool] = useState<MarkTool | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState<Mark | null>(null);
  const [notice, setNotice] = useState<MarksNotice | null>(start.notice);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const view = useRef<MarksDocument | null>(null);
  const attach = useCallback((document: MarksDocument | null) => {
    view.current = document;
  }, []);
  // The viewer closed while the marks went: nothing is sent, the marks stay for the next time.
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);

  if (!session) return null;
  const key = draftKey(session.threadId, session.path);

  // Every change is kept in the browser at once: a reload or «Назад» of a phone loses nothing. While the marks go,
  // nothing changes: a mark drawn then would not be in the message, and the sent ones are removed after it.
  const change = (next: Mark[]) => {
    if (sending) return;
    setError(null);
    setMarks(next);
    if (!storeDraft(key, { version: session.version, marks: next })) setNotice('noStorage');
  };

  // Another window, another tool, «Пометки» off: the mark not saved goes.
  const choose = (id: string | null) => {
    if (pending && pending.id !== id) setPending(null);
    setSelected(id);
  };

  return {
    marks,
    pending,
    paged: session.paged,
    active,
    tool,
    selected,
    notice,
    sending,
    running: session.running,
    error,
    toggle: () => {
      setActive((on) => !on);
      setTool(null);
      choose(null);
    },
    setTool: (next) => {
      if (sending) return;
      setTool(next);
      choose(null);
    },
    add: (mark) => {
      if (sending) return;
      const id = crypto.randomUUID();
      setPending({ id, comment: '', ...mark });
      setTool(null);
      setSelected(id);
    },
    save: (id, comment) => {
      const said = comment.trim();
      if (!said || sending) return;
      if (pending?.id === id) {
        change([...marks, { ...pending, comment: said }]);
        setPending(null);
      } else change(marks.map((m) => (m.id === id ? { ...m, comment: said } : m)));
      setSelected(null);
    },
    remove: (id) => {
      if (pending?.id === id) setPending(null);
      else change(marks.filter((m) => m.id !== id));
      setSelected((open) => (open === id ? null : open));
    },
    select: choose,
    open: (id) => {
      const mark = marks.find((m) => m.id === id);
      if (!mark || sending) return;
      view.current?.reveal(mark);
      choose(id);
    },
    attach,
    send: async () => {
      const document = view.current;
      if (!document || sending || session.running || marks.length === 0) return;
      setSending(true);
      setError(null);
      choose(null);
      setTool(null);
      try {
        // The text under the marks and the picture are made by the browser: a failure here is not the server's.
        let quotes: string[];
        let picture: Blob;
        try {
          // Selected text is quoted as it was selected; under a drawn mark — read from the page.
          quotes = await Promise.all(marks.map((m) => (m.tool === 'highlight' && m.text ? Promise.resolve(m.text) : document.quote(m))));
          picture = await document.picture(marks);
        } catch (cause) {
          console.error('APP_MARKS_PREPARE_FAILED: the marks were not made ready to send', cause);
          throw new ApiRequestError({ code: 'APP_MARKS_PREPARE_FAILED', message: ru.marks.prepareFailed, status: 0, cause });
        }
        if (!open.current) return;
        const saved = await uploadMarksPicture(session.threadId, new File([picture], ru.marks.pictureName(session.name), { type: 'image/jpeg' }));
        if (!open.current) return;
        const text = marksMessage({
          document: { name: session.name, path: session.path },
          picture: saved,
          paged: session.paged,
          marks: marks.map((m, i) => ({ tool: m.tool, page: m.page, comment: m.comment, quote: quotes[i]! })),
        });
        // The agent began to answer while the picture went: the marks stay, the person is told why.
        if (!session.send(text)) {
          setError(new ApiRequestError({ code: 'APP_MARKS_AGENT_BUSY', message: ru.marks.busy, status: 0 }));
          return;
        }
        storeDraft(key, null);
        setMarks([]);
        onSent();
      } catch (raw) {
        setError(asApiError(raw));
      } finally {
        setSending(false);
      }
    },
    escape: () => {
      if (selected) {
        choose(null);
        return true;
      }
      if (tool) {
        setTool(null);
        return true;
      }
      return false;
    },
  };
}
