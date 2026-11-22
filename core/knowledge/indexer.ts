// The reading of documents of the knowledge base (docs/specs/[20.11.2026]-knowledge-base.md, section 8): one document at
// a time, in the background, so a large upload does not slow the colleagues' chats. A version read whole becomes the one
// agents search, in one transaction with its fragments and its words; the version before leaves the search then. A
// version that could not be read (a scan, a password, a broken file) is refused with its reason, and the version before
// stays the one agents answer by. The state is in the database: a restart goes on with what was waiting.
import { extname } from 'node:path';
import { inTransaction, type Db } from '../db/pool.ts';
import type { DocTextService } from '../doctext/service.ts';
import type { DocKind } from '../doctext/extract.ts';
import { docFormatOf } from '../doctext/extract.ts';
import { logEvent } from '../server/log.ts';
import { chunksOf, normText } from './chunk.ts';
import { forgetWords, rememberWords } from './store.ts';

export const INDEX_SWEEP_MS = 30 * 1000;

export interface KnowledgeIndexer {
  wake(): void;
  // Resolves when nothing waits to be read (tests, shutdown).
  idle(): Promise<void>;
  start(): void;
  stop(): void;
}

interface Waiting {
  document_id: string;
  version: number;
  file_name: string;
  content: Buffer;
}

const REFUSALS: Record<string, string> = { password: 'APP_KNOWLEDGE_PASSWORD', scan: 'APP_KNOWLEDGE_NO_TEXT', failed: 'APP_KNOWLEDGE_BAD_TEXT', slow: 'APP_KNOWLEDGE_SLOW' };

export function createKnowledgeIndexer(deps: { db: Db; docText: Pick<DocTextService, 'full'> }): KnowledgeIndexer {
  const { db } = deps;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;

  async function refuse(w: Waiting, code: string): Promise<void> {
    await db.query(`UPDATE app.kb_versions SET status = 'rejected', error_code = $3 WHERE document_id = $1 AND version = $2`, [w.document_id, w.version, code]);
    logEvent('info', 'knowledge_refused', { documentId: w.document_id, version: w.version, code });
  }

  async function readOne(w: Waiting): Promise<'done' | 'busy'> {
    const ext = extname(w.file_name).toLowerCase();
    const extracted = await deps.docText.full(new Uint8Array(w.content), ext);
    if (extracted === null) {
      await refuse(w, 'APP_KNOWLEDGE_FORMAT');
      return 'done';
    }
    if (extracted.state === 'busy') return 'busy';
    if (extracted.state !== 'ok') {
      await refuse(w, REFUSALS[extracted.state] ?? 'APP_KNOWLEDGE_BAD_TEXT');
      return 'done';
    }
    const kind: DocKind = docFormatOf(ext)!.kind;
    const chunks = chunksOf(kind, extracted.text);
    if (chunks.length === 0) {
      await refuse(w, 'APP_KNOWLEDGE_NO_TEXT');
      return 'done';
    }
    const warning = extracted.emptyPages.length > 0 ? `Готов, но страниц без текста (сканы): ${extracted.emptyPages.length}` : null;
    await inTransaction(db, async (c) => {
      const { rows } = await c.query<{ current_version: number | null }>('SELECT current_version FROM app.kb_documents WHERE id = $1 FOR UPDATE', [w.document_id]);
      if (!rows[0]) return;
      for (const chunk of chunks) {
        await c.query('INSERT INTO app.kb_chunks (document_id, version, ord, section, page, text, norm_text) VALUES ($1, $2, $3, $4, $5, $6, $7)', [w.document_id, w.version, chunk.ord, chunk.section, chunk.page, chunk.text, normText(chunk.text)]);
      }
      await rememberWords(c, w.document_id, w.version);
      const previous = rows[0].current_version;
      // The version before leaves the search with its words; its file stays for the history.
      if (previous !== null && previous !== w.version) {
        await forgetWords(c, w.document_id, previous);
        await c.query('DELETE FROM app.kb_chunks WHERE document_id = $1 AND version = $2', [w.document_id, previous]);
      }
      await c.query(`UPDATE app.kb_versions SET status = 'ready', warning = $3, error_code = NULL, chunks = $4 WHERE document_id = $1 AND version = $2`, [w.document_id, w.version, warning, chunks.length]);
      await c.query('UPDATE app.kb_documents SET current_version = $2, updated_at = now() WHERE id = $1', [w.document_id, w.version]);
    });
    logEvent('info', 'knowledge_indexed', { documentId: w.document_id, version: w.version, chunks: chunks.length });
    return 'done';
  }

  async function sweep(): Promise<void> {
    for (;;) {
      const { rows } = await db.query<Waiting>(`SELECT document_id, version, file_name, content FROM app.kb_versions WHERE status = 'pending' ORDER BY created_at LIMIT 1`);
      const next = rows[0];
      if (!next) return;
      // A newer version waiting makes an older one pointless: the newest is read.
      const newer = await db.query(`SELECT 1 FROM app.kb_versions WHERE document_id = $1 AND version > $2 AND status = 'pending'`, [next.document_id, next.version]);
      if (newer.rowCount) {
        await db.query(`UPDATE app.kb_versions SET status = 'rejected', error_code = 'APP_KNOWLEDGE_REPLACED' WHERE document_id = $1 AND version = $2`, [next.document_id, next.version]);
        continue;
      }
      // The sandbox is busy: the next sweep reads it.
      if ((await readOne(next)) === 'busy') return;
    }
  }

  const indexer: KnowledgeIndexer = {
    wake() {
      void indexer.idle().catch((error: unknown) => logEvent('error', 'knowledge_index_failed', { error }));
    },
    idle() {
      running ??= sweep().finally(() => (running = null));
      return running;
    },
    start() {
      indexer.wake();
      timer = setInterval(() => indexer.wake(), INDEX_SWEEP_MS);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
  return indexer;
}
