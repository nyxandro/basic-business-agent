import { z } from 'zod';

// «Интерфейс» in the admin panel (spec, section 8.17): how the chat looks for every employee.

// Icons an admin may give the agent; 'spark' is the mark of a new installation. Adding one needs
// no migration. Removing one needs a migration that moves installations using it to 'spark':
// otherwise /me fails for everyone there.
export const AGENT_ICONS = ['spark', 'bot', 'brain', 'chat', 'bolt', 'star', 'smile', 'headset'] as const;
export type AgentIcon = (typeof AGENT_ICONS)[number];

export const AGENT_MARK_KINDS = ['icon', 'image', 'none'] as const;
export type AgentMarkKind = (typeof AGENT_MARK_KINDS)[number];

// What the chat shows next to the agent's words: one for all agents (decision of the owner 15.11).
export type AgentMark = { kind: 'icon'; icon: AgentIcon } | { kind: 'image'; url: string } | { kind: 'none' };

export interface InterfaceSettings {
  agentMark: AgentMark;
}

// The section's page: the chosen mark, the last chosen icon and the picture, kept while an icon or
// no mark is chosen.
export interface InterfaceAdminState {
  agentMark: AgentMarkKind;
  agentIcon: AgentIcon;
  image: { url: string } | null;
}

// Text fields of PUT /app/api/admin/interface (multipart/form-data); the picture goes as `image`.
export const interfaceFormSchema = z.object({
  agentMark: z.enum(AGENT_MARK_KINDS),
  agentIcon: z.enum(AGENT_ICONS),
});

// The browser cuts a square from the middle, scales it down to this side and saves WebP; the
// server takes at most AGENT_IMAGE_MAX_BYTES of PNG, JPEG or WebP. A source file over
// AGENT_IMAGE_SOURCE_MAX_BYTES is not opened: decoding it would hang the tab.
export const AGENT_IMAGE_SIDE_PX = 256;
export const AGENT_IMAGE_MAX_BYTES = 512 * 1024;
export const AGENT_IMAGE_SOURCE_MAX_BYTES = 20 * 1024 * 1024;
