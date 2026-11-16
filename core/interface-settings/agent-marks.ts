// The mark of each agent (spec, section 8.17; decision of the owner 16.11): app.agent_marks, a row per
// agent whose mark an admin set; an agent without one shows DEFAULT_AGENT_ICON. The chat gets the
// marks with the list of agents, the agent's page in the admin panel — with the picture kept while an
// icon is chosen.
import { AGENT_ICONS, DEFAULT_AGENT_ICON, type AgentIcon, type AgentMark, type AgentMarkAdminState, type AgentMarkKind } from '@bba/contracts';
import { writeAudit } from '../audit/audit.ts';
import { inTransaction, type Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import type { AgentImage, AgentImageType } from './image.ts';

// The address carries the start of the picture's sha256: a new picture is a new address, so the
// browser may keep one for good and never shows an old one.
const IMAGE_VERSION_LENGTH = 12;

export const imageVersion = (sha256: string) => sha256.slice(0, IMAGE_VERSION_LENGTH);
export const agentImagePath = (agentId: string) => `/app/api/agents/${encodeURIComponent(agentId)}/image`;
const imageUrl = (agentId: string, sha256: string) => `${agentImagePath(agentId)}?v=${imageVersion(sha256)}`;

export const DEFAULT_MARK: AgentMarkAdminState = { kind: 'icon', icon: DEFAULT_AGENT_ICON, image: null };

interface MarkRow {
  agent_id: string;
  kind: AgentMarkKind;
  icon: string;
  image_sha256: string | null;
}

function iconOf(row: MarkRow): AgentIcon {
  // Icons leave AGENT_ICONS only with a migration that moves their agents to the default (contracts).
  if (!(AGENT_ICONS as readonly string[]).includes(row.icon)) throw new Error(`app.agent_marks gives agent ${row.agent_id} the icon "${row.icon}", which is not in AGENT_ICONS`);
  return row.icon as AgentIcon;
}

// The marks an admin set, by agent; the bytes of the pictures stay in the base.
export async function agentMarks(db: Db): Promise<Map<string, AgentMarkAdminState>> {
  const { rows } = await db.query<MarkRow>('SELECT agent_id, kind, icon, image_sha256 FROM app.agent_marks');
  return new Map(rows.map((r) => [r.agent_id, { kind: r.kind, icon: iconOf(r), image: r.image_sha256 ? { url: imageUrl(r.agent_id, r.image_sha256) } : null }]));
}

// What the chat draws for an agent: its picture when chosen, otherwise its icon.
export function chatMark(state: AgentMarkAdminState): AgentMark {
  if (state.kind === 'icon') return { kind: 'icon', icon: state.icon };
  // The base refuses «picture» without one (migration 0020).
  if (!state.image) throw new Error('an agent mark chose a picture it does not have');
  return { kind: 'image', url: state.image.url };
}

export async function agentImage(db: Db, agentId: string): Promise<{ bytes: Buffer; type: AgentImageType; sha256: string } | null> {
  const { rows } = await db.query<{ image: Buffer | null; image_type: AgentImageType | null; image_sha256: string | null }>(
    'SELECT image, image_type, image_sha256 FROM app.agent_marks WHERE agent_id = $1',
    [agentId],
  );
  const row = rows[0];
  if (!row?.image || !row.image_type || !row.image_sha256) return null;
  return { bytes: row.image, type: row.image_type, sha256: row.image_sha256 };
}

// One write: the kind, the icon and a new picture are saved together or not at all. A picture that is
// not replaced stays, whichever kind is chosen.
export async function saveAgentMark(db: Db, actorUserId: string, agentId: string, input: { kind: AgentMarkKind; icon: AgentIcon; image: AgentImage | null }): Promise<void> {
  await inTransaction(db, async (client) => {
    // The row is made first, as the default mark, and then locked: two first saves at once wait for
    // each other instead of one failing on the key. A refused save rolls the new row back too.
    await client.query('INSERT INTO app.agent_marks (agent_id, kind, icon) VALUES ($1, $2, $3) ON CONFLICT (agent_id) DO NOTHING', [agentId, DEFAULT_MARK.kind, DEFAULT_MARK.icon]);
    const { rows } = await client.query<{ has_image: boolean }>('SELECT image IS NOT NULL AS has_image FROM app.agent_marks WHERE agent_id = $1 FOR UPDATE', [agentId]);
    if (input.kind === 'image' && !input.image && rows[0]?.has_image !== true) {
      throw appError('APP_VALIDATION_FAILED', `own picture chosen for agent ${agentId} without a picture`, { userMessage: 'Сначала выберите картинку.' });
    }
    if (input.image) {
      await client.query('UPDATE app.agent_marks SET kind = $2, icon = $3, image = $4, image_type = $5, image_sha256 = $6, updated_by = $7, updated_at = now() WHERE agent_id = $1', [
        agentId,
        input.kind,
        input.icon,
        input.image.bytes,
        input.image.type,
        input.image.sha256,
        actorUserId,
      ]);
    } else {
      await client.query('UPDATE app.agent_marks SET kind = $2, icon = $3, updated_by = $4, updated_at = now() WHERE agent_id = $1', [agentId, input.kind, input.icon, actorUserId]);
    }
    await writeAudit(client, {
      actorUserId,
      action: 'agent.mark',
      target: agentId,
      details: { kind: input.kind, icon: input.icon, ...(input.image ? { imageSha256: input.image.sha256 } : {}) },
    });
  });
}
