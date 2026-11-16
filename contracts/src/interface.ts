import { z } from 'zod';

// The look of the chat (spec, section 8.17). Every agent has its own mark — an icon of the set or the
// admin's picture — set on the agent's page in «Агенты и промпты»; «Интерфейс» decides whether the
// chat shows the marks at all (decision of the owner 16.11, replacing one mark for all agents).

// Icons an admin may give an agent. Adding one needs no migration. Removing one needs a migration
// that moves the agents using it to DEFAULT_AGENT_ICON: otherwise the list of agents fails for
// everyone there.
export const AGENT_ICONS = ['spark', 'bot', 'brain', 'chat', 'bolt', 'star', 'smile', 'headset'] as const;
export type AgentIcon = (typeof AGENT_ICONS)[number];
// The mark of an agent nobody has set: the spark, as a new installation always showed.
export const DEFAULT_AGENT_ICON: AgentIcon = 'spark';

export const AGENT_MARK_KINDS = ['icon', 'image'] as const;
export type AgentMarkKind = (typeof AGENT_MARK_KINDS)[number];

// What the chat shows next to the words of an agent (`AgentSummary.mark`).
export type AgentMark = { kind: 'icon'; icon: AgentIcon } | { kind: 'image'; url: string };

// In /me: whether the chat shows the marks of the agents at all.
export interface InterfaceSettings {
  showAgentMark: boolean;
}

// «Интерфейс»: GET and PUT /app/api/admin/interface.
export const interfaceSettingsSchema = z.object({ showAgentMark: z.boolean() });
export type InterfaceAdminState = z.infer<typeof interfaceSettingsSchema>;

// «Значок» of an agent in the admin panel: the chosen kind, the last chosen icon and the picture,
// kept while an icon is chosen.
export interface AgentMarkAdminState {
  kind: AgentMarkKind;
  icon: AgentIcon;
  image: { url: string } | null;
}

// Text fields of PUT /app/api/admin/agents/:id/mark (multipart/form-data); the picture goes as `image`.
export const agentMarkFormSchema = z.object({
  kind: z.enum(AGENT_MARK_KINDS),
  icon: z.enum(AGENT_ICONS),
});

// The browser cuts a square from the middle, scales it down to this side and saves WebP; the
// server takes at most AGENT_IMAGE_MAX_BYTES of PNG, JPEG or WebP. A source file over
// AGENT_IMAGE_SOURCE_MAX_BYTES is not opened: decoding it would hang the tab.
export const AGENT_IMAGE_SIDE_PX = 256;
export const AGENT_IMAGE_MAX_BYTES = 512 * 1024;
export const AGENT_IMAGE_SOURCE_MAX_BYTES = 20 * 1024 * 1024;
