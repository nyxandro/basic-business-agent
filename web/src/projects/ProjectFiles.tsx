// «Файлы проекта» (spec, scenario 6, section 8.20): upload, download, removal into the project's trash
// — no question, «Вернуть» in the notice — and «Корзина · N». A failed upload stays as a line with
// «Повторить». Attachments of the project's conversations land here too. In an archived project the
// files are only read. Versions of one document in any format stand as one stack until it is opened
// (decision of the owner 18.11; file-groups.ts). A removed file turns to sand and leaves the list at once,
// the rest glide into its place, as the files of a message do (request of the owner 18.11).
import { MAX_UPLOAD_BYTES, previewKindOf, UPLOAD_EXTENSIONS, type ProjectFile } from '@bba/contracts';
import { AnimatePresence, motion, MotionConfig } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError, asApiError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { Button, IconButton } from '../ui/Button.tsx';
import { Card } from '../ui/Display.tsx';
import { turnToSand } from '../ui/dissolve.ts';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { fileSize } from '../ui/format.ts';
import { FileIcon } from '../ui/FileIcon.tsx';
import { fileStackClass, FileStackHead, kindsLine } from '../ui/FileStack.tsx';
import { Icon } from '../ui/Icon.tsx';
import { DelayedBar } from '../ui/Loading.tsx';
import { EASING, MOVE_S } from '../ui/motion.ts';
import { useLoad } from '../ui/use-load.ts';
import { projectKeys } from './queries.ts';
import { useToast } from '../ui/Toast.tsx';
import { deleteProjectFile, fetchProjectFiles, fetchTrash, projectFilePreviewUrl, projectFileUrl, restoreFromTrash, uploadProjectFile } from './api.ts';
import { useDocumentViewer } from '../viewer/use-viewer.tsx';
import { documentOf, listEntries, type FileGroup } from './file-groups.ts';
import { TrashDialog } from './TrashDialog.tsx';
import styles from './projects.module.css';

const TOO_LARGE = 'APP_UPLOAD_TOO_LARGE';
const NONE: ReadonlySet<string> = new Set();

// «6 файлов · 3 версии · 3 PDF · 3 PowerPoint»
function groupLine(group: FileGroup): string {
  const names = group.files.map((f) => f.path);
  return [ru.projects.filesCount(names.length), group.versions > 1 ? ru.projects.versionsCount(group.versions) : null, kindsLine(names)].filter(Boolean).join(' · ');
}

export function ProjectFiles({ projectId, readOnly, shared }: { projectId: string; readOnly: boolean; shared: boolean }) {
  const load = useCallback(() => fetchProjectFiles(projectId), [projectId]);
  const { state, reload } = useLoad(load, projectKeys.files(projectId));
  const loadTrash = useCallback(() => fetchTrash(projectId), [projectId]);
  const { state: trash, reload: reloadTrash } = useLoad(loadTrash, projectKeys.trash(projectId));
  const [trashOpen, setTrashOpen] = useState(false);
  const toast = useToast();
  const inTrash = trash.status === 'ready' ? trash.data.batches.reduce((n, b) => n + b.items.length, 0) : 0;
  const input = useRef<HTMLInputElement>(null);
  const [failed, setFailed] = useState<{ file: File; error: ApiRequestError } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  // A click on a document opens it; «Скачать» is beside the row and in the viewer (decision of the owner 18.11).
  const { open, viewer } = useDocumentViewer();
  // Stacks opened on this project's page; an opened one stays open.
  const [opened, setOpened] = useState<{ projectId: string; keys: ReadonlySet<string> }>({ projectId, keys: NONE });
  const openedKeys = opened.projectId === projectId ? opened.keys : NONE;
  const openStack = (key: string) => setOpened((o) => ({ projectId, keys: new Set([...(o.projectId === projectId ? o.keys : []), key]) }));
  // Files being removed are off the list until the server's next list, which knows they are gone.
  const [leaving, setLeaving] = useState<{ files: readonly ProjectFile[] | null; paths: ReadonlySet<string> }>({ files: null, paths: NONE });
  const loaded = state.status === 'ready' ? state.data.files : null;
  const gone = loaded !== null && leaving.files === loaded ? leaving.paths : NONE;
  const files = loaded?.filter((f) => !gone.has(f.path)) ?? [];
  // The first file of a stack just opened takes the focus the stack had.
  const list = useRef<HTMLUListElement>(null);
  const focusNext = useRef<string | null>(null);
  useEffect(() => {
    const path = focusNext.current;
    if (path === null) return;
    focusNext.current = null;
    [...(list.current?.querySelectorAll<HTMLElement>('[data-file-path]') ?? [])].find((el) => el.dataset.filePath === path)?.focus();
  }, [opened]);

  function openGroup(group: FileGroup) {
    focusNext.current = group.files[0]!.path;
    openStack(group.key);
  }

  async function upload(file: File) {
    setFailed(null);
    if (file.size > MAX_UPLOAD_BYTES) {
      setFailed({ file, error: new ApiRequestError({ code: TOO_LARGE, message: ru.chat.tooLarge, status: 0 }) });
      return;
    }
    setBusy(file.name);
    try {
      const saved = await uploadProjectFile(projectId, file);
      // A file that joins a stack would vanish into it: the stack opens, so what came is seen.
      openStack(documentOf(saved.path).key);
      reload();
    } catch (raw) {
      setFailed({ file, error: asApiError(raw) });
    } finally {
      setBusy(null);
    }
  }

  // Into the trash at once: it can be brought back, so no question first.
  async function remove(path: string, row: HTMLElement | null) {
    setError(null);
    turnToSand(row);
    const from = loaded;
    setLeaving((l) => ({ files: from, paths: new Set([...(l.files === from ? l.paths : []), path]) }));
    try {
      const { trashId } = await deleteProjectFile(projectId, path);
      reload();
      reloadTrash();
      if (trashId) {
        toast(ru.projects.fileInTrash(path), {
          label: ru.projects.undo,
          run: () =>
            void restoreFromTrash(projectId, { ids: [trashId] }).then(
              () => (reload(), reloadTrash()),
              (raw: unknown) => setError(asApiError(raw)),
            ),
        });
      }
    } catch (raw) {
      // Back in its place: the sand hid the row, and it may still be the same element leaving.
      row?.style.removeProperty('visibility');
      setLeaving((l) => ({ files: l.files, paths: new Set([...l.paths].filter((p) => p !== path)) }));
      setError(asApiError(raw));
    }
  }

  // The files of an opened stack rise into their places when it opens.
  function fileRow(f: ProjectFile, ofOpened: boolean) {
    return (
      <motion.li key={f.path} layout className={styles.row} initial={ofOpened ? { opacity: 0, y: 8 } : false} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
        <FileIcon name={f.path} size={20} />
        <span className={styles.rowMain}>
          {previewKindOf(f.path) ? (
            <button type="button" className={styles.rowName} data-file-path={f.path} onClick={() => open({ name: f.path.split('/').at(-1)!, downloadUrl: projectFileUrl(projectId, f.path), previewUrl: projectFilePreviewUrl(projectId, f.path) })}>
              {f.path}
            </button>
          ) : (
            <a className={styles.rowName} data-file-path={f.path} href={projectFileUrl(projectId, f.path)} download>
              {f.path}
            </a>
          )}
          <span className={styles.rowMeta}>{fileSize(f.bytes)}</span>
        </span>
        <IconButton icon="download" label={`${ru.projects.download} ${f.path}`} onClick={() => window.open(projectFileUrl(projectId, f.path), '_blank')} />
        {readOnly ? null : <IconButton icon="trash" label={`${ru.projects.remove} ${f.path}`} onClick={(e) => void remove(f.path, e.currentTarget.closest('li'))} />}
      </motion.li>
    );
  }

  return (
    <Card className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>{ru.projects.files}</h2>
        <input
          ref={input}
          type="file"
          hidden
          accept={UPLOAD_EXTENSIONS.join(',')}
          aria-label={ru.projects.upload}
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = '';
            if (file) void upload(file);
          }}
        />
        {inTrash > 0 ? (
          <Button variant="ghost" icon="trash" onClick={() => setTrashOpen(true)}>
            {ru.projects.trashCount(inTrash)}
          </Button>
        ) : null}
        {readOnly ? null : (
          <Button icon="clip" onClick={() => input.current?.click()} disabled={busy !== null}>
            {ru.projects.upload}
          </Button>
        )}
      </div>
      {shared ? <p className={styles.empty}>{ru.projects.sharedFilesHint}</p> : null}
      <TrashDialog
        projectId={projectId}
        open={trashOpen}
        readOnly={readOnly}
        onClose={() => setTrashOpen(false)}
        onRestored={() => {
          reload();
          reloadTrash();
        }}
      />
      {error ? <ErrorBanner error={error} /> : null}
      {state.status === 'loading' ? <DelayedBar /> : null}
      {state.status === 'error' ? <ErrorBanner error={state.error} onRetry={reload} /> : null}
      {state.status === 'ready' ? (
        <MotionConfig reducedMotion="user" transition={{ duration: MOVE_S, ease: EASING }}>
          <ul ref={list} className={styles.rows}>
            <AnimatePresence mode="popLayout" initial={false}>
              {busy ? (
                <motion.li key="busy" layout className={styles.row} role="status" exit={{ opacity: 0 }}>
                  <FileIcon name={busy} size={20} />
                  <span className={styles.rowMain}>
                    <span className={styles.rowName}>{busy}</span>
                    <span className={styles.rowMeta}>{ru.chat.uploadingName(busy)}</span>
                  </span>
                </motion.li>
              ) : null}
              {failed ? (
                <motion.li key="failed" layout className={styles.row} role="alert" exit={{ opacity: 0 }}>
                  <Icon name="alert" size={16} />
                  <span className={styles.rowMain}>
                    <span className={`${styles.rowName} ${styles.rowBad}`}>{ru.projects.uploadFailed(failed.file.name)}</span>
                    <span className={styles.rowMeta}>
                      {failed.error.message} · {failed.error.code}
                    </span>
                  </span>
                  {/* The same file over the limit fails again: no repeat for it. */}
                  {failed.error.code === TOO_LARGE ? null : (
                    <Button size="sm" onClick={() => void upload(failed.file)}>
                      {ru.projects.retry}
                    </Button>
                  )}
                </motion.li>
              ) : null}
              {listEntries(files, openedKeys).map((entry) =>
                entry.kind === 'file' ? (
                  fileRow(entry.file, openedKeys.has(documentOf(entry.file.path).key))
                ) : (
                  <motion.li key={`stack:${entry.group.key}`} layout className={styles.stackItem} exit={{ opacity: 0 }}>
                    <div className={fileStackClass}>
                      <FileStackHead names={entry.group.files.map((f) => f.path)} title={entry.group.title} meta={groupLine(entry.group)} open={false} onClick={() => openGroup(entry.group)} />
                    </div>
                  </motion.li>
                ),
              )}
              {files.length === 0 && !busy && !failed ? (
                <motion.li key="empty" layout className={styles.empty}>
                  {ru.projects.noFiles}
                </motion.li>
              ) : null}
            </AnimatePresence>
          </ul>
        </MotionConfig>
      ) : null}
      {viewer}
    </Card>
  );
}
