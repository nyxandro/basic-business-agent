// Documents in the window of «Поиск» (spec, section 8.21): a row per file — its type, name, project and day —
// and what the list could not show: folders the server could not read, more files than shown.
import type { SearchFile, SearchFiles } from '@bba/contracts';
import { ru } from '../i18n/ru.ts';
import { FileIcon } from '../ui/FileIcon.tsx';
import { dayLabel } from '../ui/format.ts';
import { Icon } from '../ui/Icon.tsx';
import { Marked } from './Marked.tsx';
import styles from './search.module.css';

// Where a file lies: its project («Без проекта» for the person's own folder) or the conversation outside projects whose
// folder it is in (spec, section 8.33), and the folder inside, so two files of one name — one in a folder the agent
// made — are told apart.
export function placeOf(file: SearchFile, projectName: string): string {
  // `chats/<id>/…`: the folder of the conversation is named by the conversation.
  const inside = file.conversation ? file.path.split('/').slice(2).join('/') : file.path;
  const where = file.conversation ? ru.search.inConversation(file.conversation.title) : projectName;
  const cut = inside.lastIndexOf('/');
  return cut < 0 ? where : `${where} / ${inside.slice(0, cut)}`;
}

export function FileResult({ file, projectName, wide, onOpen }: { file: SearchFile; projectName: string; wide: boolean; onOpen: () => void }) {
  const when = dayLabel(file.modifiedAt);
  const place = placeOf(file, projectName);
  return (
    <button type="button" className={styles.result} onClick={onOpen}>
      <span className={styles.tile}>
        <FileIcon name={file.name} size={17} />
      </span>
      <span className={styles.resultMain}>
        <span className={styles.resultHead}>
          <span className={styles.resultTitle}>
            <Marked text={file.name} marks={file.nameMarks} />
          </span>
          {wide ? <span className={styles.when}>{when}</span> : null}
        </span>
        <span className={styles.pill}>
          {wide ? <Icon name="folder" size={12} /> : null}
          {wide ? place : `${place} · ${when}`}
        </span>
      </span>
    </button>
  );
}

// The group «Файлы» of found or newest documents; nothing when there is nothing to say.
export function FilesGroup({ found, projectName, wide, onOpen }: { found: SearchFiles; projectName: (id: string | null) => string; wide: boolean; onOpen: (file: SearchFile) => void }) {
  if (found.files.length === 0 && found.unreadable.length === 0) return null;
  return (
    <>
      <div className={styles.group}>{ru.search.files}</div>
      {found.files.map((file) => (
        <FileResult key={`${file.projectId ?? ''}/${file.path}`} file={file} projectName={projectName(file.projectId)} wide={wide} onOpen={() => onOpen(file)} />
      ))}
      {found.more ? <p className={styles.listNote}>{ru.search.firstFifty}</p> : null}
      {found.unreadable.map((folder) => (
        <p key={folder.projectId ?? ''} className={styles.listNote} role="status">
          {ru.search.unreadable(folder.name)}
        </p>
      ))}
    </>
  );
}
