// What stands over the document while «Пометки» is on (spec, section 8.32): the four tools at the top, the list of
// marks in the corner with «Отправить агенту» under it, and the window of the comment beside the mark it belongs to.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { ru } from '../../i18n/ru.ts';
import { Button, cx, IconButton } from '../../ui/Button.tsx';
import { TextArea } from '../../ui/Field.tsx';
import { Icon } from '../../ui/Icon.tsx';
import { markToSand } from './sand.ts';
import { MARK_TOOLS, COMMENT_MAX } from './types.ts';
import { useMarks } from './use-marks.ts';
import styles from './marks.module.css';

// On a phone the list starts folded to its bar, so the page stays in view; wider — open (as marks.module.css).
const WIDE = '(min-width: 600px)';
const onPhone = () => typeof window.matchMedia === 'function' && !window.matchMedia(WIDE).matches;
// Room between the mark and its window, and between the window and the edges of the view.
const GAP = 8;

export function MarksToolbar() {
  const marks = useMarks();
  if (!marks?.active) return null;
  return (
    <div className={styles.toolbar} role="toolbar" aria-label={ru.marks.tools}>
      {MARK_TOOLS.map((tool) => (
        <IconButton
          key={tool}
          icon={tool}
          label={ru.marks.tool(tool)}
          aria-pressed={marks.tool === tool}
          disabled={marks.sending}
          className={cx(styles.tool, marks.tool === tool && styles.toolOn)}
          onClick={() => marks.setTool(marks.tool === tool ? null : tool)}
        />
      ))}
    </div>
  );
}

export function MarksPanel() {
  const marks = useMarks();
  // A notice is not folded away on a phone.
  const [open, setOpen] = useState(() => !onPhone() || marks?.notice != null);
  if (!marks?.active) return null;
  const { marks: list, notice, error, sending, running } = marks;
  return (
    <section className={cx(styles.panel, marks.selected && styles.panelUnderWindow)} aria-label={ru.marks.list(list.length)}>
      <button type="button" className={styles.panelHead} aria-expanded={open} aria-label={open ? ru.marks.collapse : ru.marks.expand} onClick={() => setOpen((v) => !v)}>
        <span>{ru.marks.list(list.length)}</span>
        <Icon name={open ? 'down' : 'up'} size={16} />
      </button>
      {open ? (
        <div className={styles.panelBody}>
          {notice ? <p className={styles.notice}>{notice === 'changed' ? ru.marks.changed : ru.marks.noStorage}</p> : null}
          {list.length === 0 ? <p className={styles.start}>{ru.marks.start}</p> : null}
          {list.length > 0 ? (
            <ol className={styles.rows}>
              {list.map((mark, i) => {
                const first = mark.comment.trim().split('\n')[0];
                return (
                  <li key={mark.id}>
                    <button
                      type="button"
                      className={cx(styles.row, marks.selected === mark.id && styles.rowOn)}
                      aria-label={ru.marks.mark(i + 1)}
                      disabled={marks.sending}
                      data-mark-row={mark.id}
                      onClick={() => marks.open(mark.id)}
                    >
                      <span className={styles.number}>{i + 1}</span>
                      {marks.paged ? <span className={styles.rowPage}>{ru.marks.page(mark.page)}</span> : null}
                      <span className={cx(styles.rowText, !first && styles.rowEmpty)}>{first || ru.marks.noComment}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          ) : null}
        </div>
      ) : null}
      {list.length > 0 ? (
        <div className={styles.panelFoot}>
          {error ? (
            <p className={styles.error} role="alert">
              {error.message} <span className={styles.code}>{error.code}</span>
            </p>
          ) : null}
          <Button variant="primary" icon="up" block disabled={sending || running} onClick={() => void marks.send()}>
            {sending ? ru.marks.sending : ru.marks.send}
          </Button>
          {running && !sending ? <p className={styles.busy}>{ru.marks.busy}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

// The window of the comment of the selected mark: beside the mark (under it, or over it near the bottom), on a phone
// at the bottom of the view across its width.
export function MarkWindow() {
  const marks = useMarks();
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const selected = marks?.marks.find((m) => m.id === marks.selected) ?? null;
  const number = selected && marks ? marks.marks.indexOf(selected) + 1 : 0;
  const id = selected?.id ?? null;

  // The mark moves with scrolling and scale: the window follows it every frame it is open.
  useLayoutEffect(() => {
    if (!id) return;
    let frame = 0;
    const follow = () => {
      const node = box.current;
      // The body of the viewer the window stands in.
      const area = node?.parentElement;
      const mark = area?.querySelector(`[data-mark-id="${id}"]`);
      if (node && area && mark) {
        const view = area.getBoundingClientRect();
        const at = mark.getBoundingClientRect();
        const below = at.bottom - view.top + GAP;
        const top = below + node.offsetHeight > view.height - GAP ? Math.max(GAP, at.top - view.top - node.offsetHeight - GAP) : below;
        const left = Math.min(Math.max(GAP, at.left - view.left), view.width - node.offsetWidth - GAP);
        setPlace((was) => (was && Math.abs(was.left - left) < 0.5 && Math.abs(was.top - top) < 0.5 ? was : { left, top }));
      }
      frame = requestAnimationFrame(follow);
    };
    follow();
    return () => cancelAnimationFrame(frame);
  }, [id]);

  // The window takes the focus; closed, it gives it back to the viewer, so the keys keep working there.
  useEffect(() => {
    if (!id) return;
    const viewer = field.current?.closest<HTMLElement>('[aria-modal="true"]');
    field.current?.focus({ preventScroll: true });
    return () => {
      if (!document.activeElement || document.activeElement === document.body) viewer?.focus({ preventScroll: true });
    };
  }, [id]);

  if (!marks || !selected) return null;
  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      marks.select(null);
    }
  };
  return (
    <div
      ref={box}
      className={styles.window}
      style={(place ? { '--left': `${place.left}px`, '--top': `${place.top}px` } : { visibility: 'hidden' }) as CSSProperties}
      role="dialog"
      aria-label={ru.marks.mark(number)}
    >
      <div className={styles.windowHead}>
        <span className={styles.number}>{number}</span>
        <span>{ru.marks.mark(number)}</span>
      </div>
      <TextArea
        ref={field}
        aria-label={ru.marks.commentLabel}
        placeholder={ru.marks.commentPlaceholder}
        value={selected.comment}
        maxLength={COMMENT_MAX}
        rows={3}
        onChange={(event) => marks.setComment(selected.id, event.target.value)}
        onKeyDown={keys}
      />
      <div className={styles.windowActions}>
        <Button
          variant="ghost"
          size="sm"
          icon="trash"
          onClick={() => {
            markToSand(selected.id);
            marks.remove(selected.id);
          }}
        >
          {ru.marks.remove}
        </Button>
        <Button variant="primary" size="sm" onClick={() => marks.select(null)}>
          {ru.marks.done}
        </Button>
      </div>
    </div>
  );
}
