import { z } from 'zod';
import type { Permission } from './auth.ts';
import type { AgentMarkAdminState } from './interface.ts';

const rub = z.number().min(0).nullable();
const tokens = z.number().int().positive().nullable();

export const limitSettingsSchema = z.object({
  orgMonthlyRub: rub,
  defaultUserMonthlyRub: rub,
  defaultDailySubscriptionTokens: tokens,
});
export type LimitSettingsBody = z.infer<typeof limitSettingsSchema>;

// A personal value replaces the default; null means "the default applies".
export const userLimitsSchema = z.object({ monthlyRub: rub, dailySubscriptionTokens: tokens });

export const orgProfileSchema = z.object({
  name: z.string().trim().min(1).max(120),
  tone: z.string().max(2000),
  requisites: z.string().max(4000),
  industry: z.string().max(500),
});

export const MASKING_KIND_IDS = ['passport', 'snils', 'card', 'inn', 'phone', 'email'] as const;
export const maskingSettingsSchema = z.object({ kinds: z.array(z.enum(MASKING_KIND_IDS)) });

export const promptDraftSchema = z.object({ text: z.string(), baseDraftVersionId: z.string().nullable() });
export const agentModelSchema = z.object({ modelId: z.string().nullable() });
// null — the starter questions of the agent's passport.
export const agentStartersSchema = z.object({ starters: z.array(z.string().trim().min(1).max(200)).max(3).nullable() });

export interface UsageDay {
  // YYYY-MM-DD in the installation's time zone.
  day: string;
  costRub: number;
}

export const userProfileSchema = z.object({ name: z.string().trim().min(1), position: z.string().max(200) });

export const journalQuerySchema = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  userId: z.string().optional(),
  agentId: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
});

// Answers of the admin panel, as the web interface reads them.
export interface AdminUser {
  id: string;
  email: string;
  name: string;
  position: string;
  blocked: boolean;
  roleIds: string[];
  departmentIds: string[];
  createdAt: string;
  // Their projects and how many are open to colleagues: removal gives them to the administrator.
  projects: { total: number; shared: number };
}

// GET admin/people: whom a skill or a background task can be for — names only.
export interface AdminPerson {
  id: string;
  name: string;
}

export interface AdminPeopleResponse {
  people: AdminPerson[];
}

export interface AdminRole {
  id: string;
  name: string;
  permissions: Permission[];
  builtin: 'superadmin' | 'employee' | null;
  userCount: number;
}

export interface AdminDepartment {
  id: string;
  name: string;
  userIds: string[];
  agentIds: string[];
}

export interface AdminInvite {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  expiresAt: string;
}

// An invite or a password reset: the link the admin copies and sends (spec: no e-mails).
export interface IssuedLink {
  id: string;
  link: string;
  expiresAt: string;
}

// A personal value; null means the default from «Лимиты» applies.
export interface PersonalLimit {
  userId: string;
  monthlyRub: number | null;
  dailySubscriptionTokens: number | null;
}

export interface AdminAgent {
  id: string;
  name: string;
  description: string;
  // The agent's own model from the catalog; null — the organisation's model.
  modelId: string | null;
  // Departments that see the agent.
  departmentNames: string[];
  // Starter questions of the empty chat: the admin's when set (startersCustom), else the passport's.
  starters: string[];
  startersCustom: boolean;
  // A version of the prompt edited in the admin panel is in use.
  promptChanged: boolean;
  // «Значок» of the agent (spec, section 8.17).
  mark: AgentMarkAdminState;
  // «Что агенту можно» (spec, section 8.30).
  abilities: AgentAbilities;
}

// What an agent may do (spec, sections 8.30 and 8.31): the internet (search and pages, through the researcher), the
// commands of the sandbox and the widgets in the chat («Виджеты в чате»). Its sub-agents work with the same.
export interface AgentAbilities {
  web: boolean;
  commands: boolean;
  widgets: boolean;
}

// PUT /app/api/admin/agents/:id/abilities: one switch or several.
export const agentAbilitiesPatchSchema = z
  .object({ web: z.boolean().optional(), commands: z.boolean().optional(), widgets: z.boolean().optional() })
  .refine((p) => p.web !== undefined || p.commands !== undefined || p.widgets !== undefined, { message: 'at least one of web, commands, widgets' });

export interface AdminAgentsResponse {
  agents: AdminAgent[];
  // Departments still point at agents removed from the installation.
  missingAgents: string[];
}

export interface PromptState {
  agentId: string;
  fileInstructions: string;
  publishedInstructions: string | null;
  draftInstructions: string | null;
  draftVersionId: string | null;
  draftBy: string | null;
  publishedAt: string | null;
  fileChangedSincePublish: boolean;
  modelId: string | null;
  // Chat models an agent may take while «Агенты выбирают модель из каталога» is on; else empty.
  allowedModels: { id: string; label: string }[];
}

export const USAGE_GROUPS = ['user', 'agent', 'model', 'deployment'] as const;
export type UsageGroup = (typeof USAGE_GROUPS)[number];

export interface UsageRow {
  key: string;
  label: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costRub: number;
  lastCallAt: string | null;
}

export interface UsageReport {
  rows: UsageRow[];
  totalRub: number;
  orgLimitRub: number | null;
}

export interface AdminConnectionsResponse {
  connections: AdminConnection[];
  // Active employees of the installation: «Подключено у N из M».
  employeesTotal: number;
}

export interface AdminConnection {
  id: string;
  title: string;
  mode: 'personal' | 'shared';
  auth: 'oauth' | 'static' | 'identity';
  // Employees by the state of their access: connected, unverified, auth_error.
  employees: Record<string, number>;
}

export interface JournalEntry {
  id: string;
  at: string;
  user: string | null;
  agent: string | null;
  runKind: string;
  event: string;
  tool: string | null;
  args: unknown;
  // The name of who answered «Да»; null when no «Да» was needed.
  approvedBy: string | null;
  result: string;
  errorCode: string | null;
}

export interface JournalPage {
  entries: JournalEntry[];
  pageSize: number;
}
