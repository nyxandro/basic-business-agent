// A conversation in the window of «Поиск»: its name, the day, where the words were found, its project;
// a background task's result not yet opened is marked «новое».
import { ru } from '../i18n/ru.ts';
import { dayLabel } from '../ui/format.ts';
import { Icon } from '../ui/Icon.tsx';
import styles from './search.module.css';

export interface ThreadResultData {
  title: string;
  updatedAt: string;
  snippet?: string;
  unread?: boolean;
}

export function ThreadResult({ thread, projectName, wide, onOpen }: { thread: ThreadResultData; projectName: string; wide: boolean; onOpen: () => void }) {
  const when = dayLabel(thread.updatedAt);
  return (
    <button type="button" className={styles.result} onClick={onOpen}>
      <span className={styles.tile}>
        <Icon name="chat" size={15} />
      </span>
      <span className={styles.resultMain}>
        <span className={styles.resultHead}>
          <span className={styles.resultTitle}>{thread.title}</span>
          {thread.unread ? <span className={styles.unread}>{ru.chat.unread}</span> : null}
          {wide ? <span className={styles.when}>{when}</span> : null}
        </span>
        {thread.snippet ? <span className={styles.snippet}>{thread.snippet}</span> : null}
        <span className={styles.pill}>
          {wide ? <Icon name="folder" size={12} /> : null}
          <span>{projectName}</span>
          {wide ? null : <span>· {when}</span>}
        </span>
      </span>
    </button>
  );
}
