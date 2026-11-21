// A conversation in «Недавние» (spec, section 8.16; owner's list 16.11): its link with its mark, and three dots on
// hover — on a phone always — with «Переименовать» and «Удалить». The name is changed in place
// (`RenameField`), and the keyboard comes back to the conversation; deleting asks first.
import { THREAD_TITLE_MAX, type ThreadState, type ThreadSummaryDto } from '@bba/contracts';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { deleteThread, renameThread } from '../chat/api.ts';
import { ru } from '../i18n/ru.ts';
import { cx, IconButton } from '../ui/Button.tsx';
import { useConfirm } from '../ui/Confirm.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Menu, MenuAnchor, MenuItem } from '../ui/Menu.tsx';
import { useToast } from '../ui/Toast.tsx';
import { RenameField } from './RenameField.tsx';
import { ThreadStateMark } from './ThreadState.tsx';
import styles from './shell.module.css';

export const threadPath = (t: Pick<ThreadSummaryDto, 'agentId' | 'id'>) => `/agents/${encodeURIComponent(t.agentId)}?thread=${encodeURIComponent(t.id)}`;

// `state` — its mark (decision of the owner 22.11): an agent works there, a question waits, the answer broke or is ready.
export function ThreadRow({ thread, state, current, onNavigate, onRenamed, onDeleted }: { thread: ThreadSummaryDto; state: ThreadState | undefined; current: boolean; onNavigate: () => void; onRenamed: (title: string) => void; onDeleted: () => void }) {
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const confirm = useConfirm();
  const toast = useToast();
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
  async function remove() {
    setMenu(false);
    if (!(await confirm({ title: ru.chat.deleteConfirm, confirmLabel: ru.chat.deleteThread, danger: true }))) return;
    setError(null);
    try {
      await deleteThread(thread.id);
      toast(ru.chat.threadDeleted);
      onDeleted();
    } catch (raw) {
      setError(asApiError(raw));
    }
  }
  return (
    <>
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
          <ThreadStateMark state={state} />
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
              <MenuItem icon="trash" danger onSelect={() => void remove()}>
                {ru.shell.remove}
              </MenuItem>
            </Menu>
          </MenuAnchor>
        </div>
      </div>
      {error ? <ErrorBanner error={error} /> : null}
    </>
  );
}
