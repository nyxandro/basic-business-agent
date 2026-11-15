// The one row of app.interface_settings (spec, section 8.17): what «Интерфейс» chose and what the
// chat of every employee gets through /me.
import { AGENT_ICONS, type AgentIcon, type AgentMark, type AgentMarkKind, type InterfaceAdminState } from '@bba/contracts';
import { writeAudit } from '../audit/audit.ts';
import { inTransaction, type Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import type { AgentImage, AgentImageType } from './image.ts';

// The address carries the start of the picture's sha256: a new picture is a new address, so the
// browser may keep one for good and never shows an old one.
const IMAGE_VERSION_LENGTH = 12;
export const AGENT_IMAGE_PATH = '/app/api/interface/agent-image';

interface SettingsRow {
  agent_mark: AgentMarkKind;
  agent_icon: string;
  agent_image_sha256: string | null;
}

export const imageVersion = (sha256: string) => sha256.slice(0, IMAGE_VERSION_LENGTH);
const imageUrl = (sha256: string) => `${AGENT_IMAGE_PATH}?v=${imageVersion(sha256)}`;

function iconOf(value: string): AgentIcon {
  // Icons leave AGENT_ICONS only with a migration that moves their users to 'spark' (contracts).
  if (!(AGENT_ICONS as readonly string[]).includes(value)) throw new Error(`app.interface_settings has the icon "${value}", which is not in AGENT_ICONS`);
  return value as AgentIcon;
}

async function readRow(db: Db): Promise<SettingsRow> {
  const { rows } = await db.query<SettingsRow>('SELECT agent_mark, agent_icon, agent_image_sha256 FROM app.interface_settings');
  if (!rows[0]) throw new Error('app.interface_settings has no row: migration 0012 inserts it');
  return rows[0];
}

export async function agentMark(db: Db): Promise<AgentMark> {
  const row = await readRow(db);
  if (row.agent_mark === 'none') return { kind: 'none' };
  if (row.agent_mark === 'image') {
    if (!row.agent_image_sha256) throw new Error('app.interface_settings chose a picture it does not have');
    return { kind: 'image', url: imageUrl(row.agent_image_sha256) };
  }
  return { kind: 'icon', icon: iconOf(row.agent_icon) };
}

export async function interfaceAdminState(db: Db): Promise<InterfaceAdminState> {
  const row = await readRow(db);
  return {
    agentMark: row.agent_mark,
    agentIcon: iconOf(row.agent_icon),
    image: row.agent_image_sha256 ? { url: imageUrl(row.agent_image_sha256) } : null,
  };
}

export async function agentImage(db: Db): Promise<{ bytes: Buffer; type: AgentImageType; sha256: string } | null> {
  const { rows } = await db.query<{ agent_image: Buffer | null; agent_image_type: AgentImageType | null; agent_image_sha256: string | null }>(
    'SELECT agent_image, agent_image_type, agent_image_sha256 FROM app.interface_settings',
  );
  const row = rows[0];
  if (!row?.agent_image || !row.agent_image_type || !row.agent_image_sha256) return null;
  return { bytes: row.agent_image, type: row.agent_image_type, sha256: row.agent_image_sha256 };
}

// One write: the mark, the icon and a new picture are saved together or not at all. A picture that
// is not replaced stays, whichever mark is chosen.
export async function saveInterfaceSettings(
  db: Db,
  actorUserId: string,
  input: { agentMark: AgentMarkKind; agentIcon: AgentIcon; image: AgentImage | null },
): Promise<void> {
  await inTransaction(db, async (client) => {
    const { rows } = await client.query<{ has_image: boolean }>('SELECT agent_image IS NOT NULL AS has_image FROM app.interface_settings FOR UPDATE');
    if (!rows[0]) throw new Error('app.interface_settings has no row: migration 0012 inserts it');
    if (input.agentMark === 'image' && !input.image && !rows[0].has_image) {
      throw appError('APP_VALIDATION_FAILED', 'own picture chosen without a picture', { userMessage: 'Сначала выберите картинку.' });
    }
    if (input.image) {
      await client.query(
        `UPDATE app.interface_settings SET agent_mark = $1, agent_icon = $2, agent_image = $3, agent_image_type = $4, agent_image_sha256 = $5, updated_by = $6, updated_at = now()`,
        [input.agentMark, input.agentIcon, input.image.bytes, input.image.type, input.image.sha256, actorUserId],
      );
    } else {
      await client.query('UPDATE app.interface_settings SET agent_mark = $1, agent_icon = $2, updated_by = $3, updated_at = now()', [input.agentMark, input.agentIcon, actorUserId]);
    }
    await writeAudit(client, {
      actorUserId,
      action: 'interface.update',
      target: null,
      details: { agentMark: input.agentMark, agentIcon: input.agentIcon, ...(input.image ? { imageSha256: input.image.sha256 } : {}) },
    });
  });
}
