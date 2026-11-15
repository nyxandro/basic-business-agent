// The file block (spec, section 8.18): a file the agent made in the folder of the conversation — its
// icon, name, size and «Скачать». Drawn from the result of show_file, where the server says the file
// is there; a call that found no file draws nothing (the model is told and tries again).
import { fileBlockResultSchema } from '@bba/contracts';
import { threadFileUrl } from '../chat/api.ts';
import { parseToolResult } from '../chat/tool-result.ts';
import { ru } from '../i18n/ru.ts';
import { ButtonLink } from '../ui/Button.tsx';
import { FileIcon } from '../ui/FileIcon.tsx';
import { fileSize } from '../ui/format.ts';
import { Preparing, type CallProps } from './CatalogBlock.tsx';
import styles from './genui.module.css';

export function FileBlockView({ name, bytes, href }: { name: string; bytes: number; href: string }) {
  return (
    <article className={`${styles.block} ${styles.file}`}>
      <FileIcon name={name} size={32} />
      <div className={styles.fileText}>
        <div className={styles.fileName} title={name}>
          {name}
        </div>
        <div className={styles.fileSize}>{fileSize(bytes)}</div>
      </div>
      <ButtonLink href={href} download={name} icon="download" size="sm" aria-label={ru.genui.downloadFile(name)}>
        {ru.genui.download}
      </ButtonLink>
    </article>
  );
}

export function FileCall({ call, threadId }: { call: CallProps; threadId: string }) {
  if (call.status !== 'complete') return <Preparing />;
  const outcome = parseToolResult(call.result);
  if (outcome.kind !== 'ok') return null;
  const parsed = fileBlockResultSchema.safeParse(outcome.value);
  if (!parsed.success || !parsed.data.shown) return null;
  return <FileBlockView name={parsed.data.name} bytes={parsed.data.bytes} href={threadFileUrl(threadId, parsed.data.path)} />;
}
