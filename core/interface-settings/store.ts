// The one row of app.interface_settings (spec, section 8.17): whether the chat of every employee shows
// the marks of the agents, and whether the documents the agent made carry the heart of samples
// (docs/specs/[20.11.2026]-feedback-and-value.md, F6). The marks themselves belong to the agents (agent-marks.ts).
import type { InterfaceAdminState, InterfaceChange } from '@bba/contracts';
import { writeAudit } from '../audit/audit.ts';
import { inTransaction, type Db } from '../db/pool.ts';

export async function interfaceAdminState(db: Db): Promise<InterfaceAdminState> {
  const { rows } = await db.query<{ show_agent_mark: boolean; document_samples: boolean }>('SELECT show_agent_mark, document_samples FROM app.interface_settings');
  if (!rows[0]) throw new Error('app.interface_settings has no row: migration 0012 inserts it');
  return { showAgentMark: rows[0].show_agent_mark, documentSamples: rows[0].document_samples };
}

// Only the switches named change: NULL keeps the column as it is.
export async function saveInterfaceSettings(db: Db, actorUserId: string, change: InterfaceChange): Promise<void> {
  await inTransaction(db, async (client) => {
    const { rowCount } = await client.query(
      'UPDATE app.interface_settings SET show_agent_mark = COALESCE($1, show_agent_mark), document_samples = COALESCE($2, document_samples), updated_by = $3, updated_at = now()',
      [change.showAgentMark ?? null, change.documentSamples ?? null, actorUserId],
    );
    if (rowCount !== 1) throw new Error('app.interface_settings has no row: migration 0012 inserts it');
    await writeAudit(client, { actorUserId, action: 'interface.update', target: null, details: change });
  });
}
