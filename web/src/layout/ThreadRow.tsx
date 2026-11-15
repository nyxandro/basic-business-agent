// A conversation in «Недавние» (spec, section 8.16): its link, and three dots on hover — on a phone
// always — with «Переименовать». The name is changed in place (`RenameField`), and the keyboard
// comes back to the conversation.
import { THREAD_TITLE_MAX, type ThreadSummaryDto } from '@bba/contracts';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { renameThread } from '../chat/api.ts';
import { ru } from '../i18n/ru.ts';
import { cx, IconButton } from '../ui/Button.tsx';
import { Menu, MenuAnchor, MenuItem } from '../ui/Menu.tsx';
import { RenameField } from './RenameField.tsx';
import styles from './shell.module.css';

export const threadPath = (t: Pick<ThreadSummaryDto, 'agentId' | 'id'>) => `/agents/${encodeURIComponent(t.agentId)}?thread=${encodeURIComponent(t.id)}`;

export function ThreadRow({ thread, current, onNavigate, onRenamed }: { thread: ThreadSummaryDto; current: boolean; onNavigate: () => void; onRenamed: (title: string) => void }) {
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  // The link comes back after the field: it takes the keyboard when the field had it.
  const refocus = useRef(false);
  if (editing) {
    return (
      <RenameField
        value={thread.title}
        label={ru.shell.threadName}
        saveLabel={ru.shell.saveName}
        maxLength={THREAD_TITLE_MAX}
        save={async (name) => (await renameThread(thread.id, name)).thread.title}
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
