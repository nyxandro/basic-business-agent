// The one row of app.interface_settings (spec, section 8.17): whether the chat of every employee shows
// the marks of the agents. The marks themselves belong to the agents (agent-marks.ts).
import type { InterfaceAdminState } from '@bba/contracts';
import { writeAudit } from '../audit/audit.ts';
import { inTransaction, type Db } from '../db/pool.ts';

export async function interfaceAdminState(db: Db): Promise<InterfaceAdminState> {
  const { rows } = await db.query<{ show_agent_mark: boolean }>('SELECT show_agent_mark FROM app.interface_settings');
  if (!rows[0]) throw new Error('app.interface_settings has no row: migration 0012 inserts it');
  return { showAgentMark: rows[0].show_agent_mark };
}

export async function saveInterfaceSettings(db: Db, actorUserId: string, input: InterfaceAdminState): Promise<void> {
  await inTransaction(db, async (client) => {
    const { rowCount } = await client.query('UPDATE app.interface_settings SET show_agent_mark = $1, updated_by = $2, updated_at = now()', [input.showAgentMark, actorUserId]);
    if (rowCount !== 1) throw new Error('app.interface_settings has no row: migration 0012 inserts it');
    await writeAudit(client, { actorUserId, action: 'interface.update', target: null, details: { showAgentMark: input.showAgentMark } });
  });
}
