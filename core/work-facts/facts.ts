// The facts of work (docs/specs/[20.11.2026]-feedback-and-value.md, section 8): a row written when the work is done —
// a document the agent made, an action that ran, a letter sent, a background run done, a search of the internet with
// sources, an answer by the knowledge base; and the person's own conversations and messages for «работали с агентами».
// The report counts these rows, never the stored messages: removing a conversation or a person does not change past
// months. The work matters more than its fact: a failure here is logged, never thrown into the work.
import type { WorkKind } from '@bba/contracts';
import type { Db } from '../db/pool.ts';
import { logEvent } from '../log/log.ts';

export type FactKind = WorkKind | 'conversation' | 'message';

// `runKind` — the kind of the run the work was done in: the check of a prompt's draft is the admin's, not work of value.
export interface Who {
  userId: string | null;
  agentId: string | null;
  runKind?: string | null;
}

export interface WorkFacts {
  record(kind: FactKind, who: Who): Promise<void>;
}

export function createWorkFacts(db: Db): WorkFacts {
  return {
    async record(kind, { userId, agentId, runKind }) {
      if (runKind === 'draft') return;
      try {
        // The person's departments at the time: the report by departments does not move when people move.
        await db.query(
          `INSERT INTO app.work_facts (kind, user_id, agent_id, department_ids)
           VALUES ($1, $2, $3, coalesce((SELECT array_agg(department_id) FROM app.department_members WHERE user_id = $2), '{}'))`,
          [kind, userId, agentId],
        );
      } catch (error) {
        logEvent('error', 'work_fact_failed', { code: 'APP_INTERNAL', kind, agentId, error });
      }
    },
  };
}

export const recordFact = (db: Db, kind: FactKind, who: Who): Promise<void> => createWorkFacts(db).record(kind, who);

// Office documents and PDF: what counts as a document the agent made.
const DOCUMENT_EXTENSIONS = new Set(['.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.pdf', '.odt', '.ods', '.odp', '.rtf']);
export const isDocumentName = (name: string) => DOCUMENT_EXTENSIONS.has(name.slice(name.lastIndexOf('.')).toLowerCase());
