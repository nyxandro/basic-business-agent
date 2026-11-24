// A write of the agent onto the person's computer in the chat (spec, section 8.25, «Запись в папку»). While the browser's
// tool waits, the card asks «Да»: each file, where it goes, a new one or which it replaces — and a warning when the person
// saved that file after the agent read it. Done: each file written is the block of a file of the conversation (its
// snapshot on the server: «Открыть», «Скачать») with where it lies on the computer, and «Вернуть прежнюю версию» for a file
// replaced; what failed says why. Until then — the line of the call.
import { COMPUTER_TOOLS, readComputerWriteResult, type AgentSummary, type ComputerWriteItem } from '@bba/contracts';
import { useState } from 'react';
import { useChatExtras } from '../answer/chat-context.ts';
import { asApiError } from '../api/client.ts';
import { FileBlockView } from '../genui/FileBlock.tsx';
import type { CallProps } from '../genui/CatalogBlock.tsx';
import { dateTime } from '../i18n/format.ts';
import { ru } from '../i18n/ru.ts';
import { FolderError } from '../projects/computer-folder.ts';
import { answerWrite, restorePrevious, usePendingWrite, useThreadFolder, type WriteAsk } from '../projects/computer-saves.ts';
import { fetchThreadFileStatus, threadFilePreviewUrl, threadFileUrl } from '../threads/api.ts';
import { Button } from '../ui/Button.tsx';
import { Icon } from '../ui/Icon.tsx';
import styles from './computer-write.module.css';
import { ToolRow } from './ToolRow.tsx';

const t = ru.computer;

const baseName = (path: string) => path.split('/').pop() ?? path;

function AskCard({ toolCallId, ask }: { toolCallId: string; ask: WriteAsk }) {
  const title = t.writeAsk(ask.folder);
  const replaces = ask.items.some((i) => i.exists);
  return (
    <div role="group" aria-label={title} className={styles.ask}>
      <div className={styles.askTitle}>
        <Icon name="monitor" size={16} />
        <span>{title}</span>
      </div>
      <ul className={styles.askList}>
        {ask.items.map((item) => (
          <li key={item.to} className={styles.askItem}>
            <span className={styles.askPath}>{item.to}</span>
            {baseName(item.file) !== baseName(item.to) ? <span className={styles.askFrom}>{t.writeFrom(baseName(item.file))}</span> : null}
            <span className={item.exists ? styles.askReplace : styles.askNew}>{item.exists ? t.writeReplace(dateTime(new Date(item.exists.lastModified).toISOString())) : t.writeNew}</span>
            {item.changedSinceRead ? <span className={styles.askWarn}>{t.writeChanged}</span> : null}
          </li>
        ))}
      </ul>
      {replaces ? <p className={styles.askNote}>{t.writeKeep}</p> : null}
      <div className={styles.askActions}>
        <Button size="sm" variant="primary" onClick={() => answerWrite(toolCallId, true)}>
          {t.writeYes}
        </Button>
        <Button size="sm" onClick={() => answerWrite(toolCallId, false)}>
          {t.writeNo}
        </Button>
      </div>
    </div>
  );
}

// What a failed «Вернуть прежнюю версию» says: the kept version is gone after 30 days, or what went wrong.
function restoreFailure(error: unknown): string {
  if (error instanceof FolderError) return error.message;
  const failure = asApiError(error);
  return failure.code === 'APP_FILE_DELETED' ? t.restoreGone : failure.message;
}

function Written({ threadId, folderName, item }: { threadId: string; folderName: string; item: Extract<ComputerWriteItem, { written: true }> }) {
  const folder = useThreadFolder(threadId);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  // The version goes back only into the folder it came from: the project may have another one now.
  function askRestore() {
    setNote(null);
    if (!folder) return setNote({ ok: false, text: t.restoreNoFolder });
    if (folder.name !== folderName) return setNote({ ok: false, text: t.restoreOtherFolder(folder.name) });
    setAsking(true);
  }
  async function restore(previous: string) {
    if (!folder) return;
    setAsking(false);
    setBusy(true);
    try {
      await restorePrevious(folder, threadId, item.to, previous);
      setNote({ ok: true, text: t.restored });
    } catch (error) {
      setNote({ ok: false, text: restoreFailure(error) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={styles.written}>
      <FileBlockView
        name={item.name}
        bytes={item.bytes}
        href={threadFileUrl(threadId, item.snapshot)}
        previewHref={threadFilePreviewUrl(threadId, item.snapshot)}
        checkFile={() => fetchThreadFileStatus(threadId, item.snapshot)}
      />
      <div className={styles.writtenLine}>
        <Icon name="monitor" size={14} />
        <span className={styles.writtenWhere}>{t.written(item.to, item.replaced)}</span>
        {item.previous && !asking ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={askRestore}>
            {t.restore}
          </Button>
        ) : null}
      </div>
      {asking && item.previous ? (
        <div className={styles.confirm}>
          <span>{t.restoreConfirm(item.to)}</span>
          <div className={styles.askActions}>
            <Button size="sm" variant="primary" onClick={() => void restore(item.previous!)}>
              {t.restoreYes}
            </Button>
            <Button size="sm" onClick={() => setAsking(false)}>
              {t.restoreNo}
            </Button>
          </div>
        </div>
      ) : null}
      {note ? <p className={note.ok ? styles.done : styles.failed}>{note.text}</p> : null}
    </div>
  );
}

export function ComputerWriteCall({ call, agent }: { call: CallProps; agent: Pick<AgentSummary, 'systems' | 'actions'> }) {
  const { threadId } = useChatExtras();
  const ask = usePendingWrite(call.toolCallId);
  if (ask) return <AskCard toolCallId={call.toolCallId} ask={ask} />;
  const result = call.status === 'complete' && call.result !== undefined ? readComputerWriteResult(call.result) : null;
  // Under way, or a result that is not a write's (a refusal of the input by Mastra): the line of the call says it.
  if (!result) return <ToolRow name={COMPUTER_TOOLS.write} status={call.status} parameters={call.parameters} result={call.result} agent={agent} />;
  if ('declined' in result) return <p className={styles.declined}>{t.writeDeclined}</p>;
  // Nothing was asked: a file in the way, no right to write — the agent hears it too.
  if ('error' in result) return <p className={styles.failed}>{result.error}</p>;
  return (
    <div className={styles.writes}>
      {result.items.map((item) =>
        item.written ? (
          <Written key={item.to} threadId={threadId} folderName={result.folder} item={item} />
        ) : (
          <p key={item.to} className={styles.failed}>
            {t.writeFailed(item.to, item.error)}
          </p>
        ),
      )}
    </div>
  );
}
