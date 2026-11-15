// A conversation in «Недавние» (spec, section 8.16): its link, and three dots on hover — on a phone
// always — with «Переименовать». The name is changed in place: Enter or ✓ saves, Esc gives up, and
// the keyboard comes back to the conversation; a field left with the name unchanged closes, one with
// a new name stays open so nothing typed is lost.
import { THREAD_TITLE_MAX, type ThreadSummaryDto } from '@bba/contracts';
import { useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { renameThread } from '../chat/api.ts';
import { ru } from '../i18n/ru.ts';
import fields from '../projects/projects.module.css';
import { cx, IconButton } from '../ui/Button.tsx';
import { Menu, MenuAnchor, MenuItem } from '../ui/Menu.tsx';
import styles from './shell.module.css';

export const threadPath = (t: Pick<ThreadSummaryDto, 'agentId' | 'id'>) => `/agents/${encodeURIComponent(t.agentId)}?thread=${encodeURIComponent(t.id)}`;

// `onDone` gets the new name once it is saved, null when the person gave up; `fromField` — the field
// had the keyboard to the end (not left for something else).
function RenameField({ thread, onDone }: { thread: ThreadSummaryDto; onDone: (title: string | null, fromField: boolean) => void }) {
  const [name, setName] = useState(thread.title);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState(false);
  const unchanged = name.trim() === thread.title;

  async function save() {
    if (busy || !name.trim()) return;
    if (unchanged) return onDone(null, true);
    setBusy(true);
    setError(null);
    try {
      onDone((await renameThread(thread.id, name.trim())).thread.title, true);
    } catch (raw) {
      setError(asApiError(raw));
      setBusy(false);
    }
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') void save();
    if (e.key === 'Escape') onDone(null, true);
  };
  return (
    <>
      <div className={fields.newProject}>
        {/* The field opens on the person's «Переименовать»: focusing it is what they asked for. */}
        <input
          className={fields.newInput}
          autoFocus
          value={name}
          maxLength={THREAD_TITLE_MAX}
          aria-label={ru.shell.threadName}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={onKey}
          onBlur={() => unchanged && onDone(null, false)}
        />
        {/* Pressing ✓ must not take the focus away from the field first. */}
        <IconButton icon="check" variant="primary" size="sm" label={ru.shell.saveName} onMouseDown={(e) => e.preventDefault()} onClick={() => void save()} disabled={!name.trim() || busy} />
      </div>
      {error ? <p className={fields.fieldError}>{error.message}</p> : null}
    </>
  );
}

export function ThreadRow({ thread, current, onNavigate, onRenamed }: { thread: ThreadSummaryDto; current: boolean; onNavigate: () => void; onRenamed: (title: string) => void }) {
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  // The link comes back after the field: it takes the keyboard when the field had it.
  const refocus = useRef(false);
  if (editing) {
    return (
      <RenameField
        thread={thread}
        onDone={(title, fromField) => {
          refocus.current = fromField;
          setEditing(false);
          if (title) onRenamed(title);
        }}
      />
    );
  }
  const label = ru.shell.threadMenuOf(thread.title);
  return (
    <div className={cx(styles.threadRow, current && styles.itemCurrent, menu && styles.threadRowOpen)}>
      <Link
        ref={(link) => {
          if (!link || !refocus.current) return;
          refocus.current = false;
          link.focus();
        }}
        to={threadPath(thread)}
        onClick={onNavigate}
        className={cx(styles.item, styles.threadLink)}
        aria-current={current ? 'page' : undefined}
      >
        <span className={styles.itemText}>{thread.title}</span>
        {thread.unread ? <span className={styles.newPill}>{ru.chat.unread}</span> : null}
      </Link>
      <div className={styles.threadMore}>
        <MenuAnchor>
          <IconButton icon="dots" size="sm" label={label} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)} />
          <Menu open={menu} onClose={() => setMenu(false)} label={label}>
            <MenuItem
              icon="edit"
              onSelect={() => {
                setMenu(false);
                setEditing(true);
              }}
            >
              {ru.shell.rename}
            </MenuItem>
          </Menu>
        </MenuAnchor>
      </div>
    </div>
  );
}
