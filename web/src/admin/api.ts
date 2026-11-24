// Calls of the admin panel (spec, section 17.5: admin/*). Each section needs its role right.
import type {
  MailReachResponse,
  TaskAccess,
  TaskEventsResponse,
  ApprovalSettingsDto,
  OrgAssetKind,
  OrgAssetsState,
  OrgDirector,
  McpProbeInput,
  McpProbeResult,
  McpServerInput,
  McpServerPatch,
  McpServerView,
  AgentAbilities,
  AgentAccess,
  AgentIcon,
  AgentMarkAdminState,
  AgentMarkKind,
  InterfaceAdminState,
  InterfaceChange,
  StorageConnectInput,
  AdminMailResponse,
  MailOAuthAppInput,
  MailOAuthProvider,
  StorageKeysInput,
  StorageStatus,
  AdminAgentsResponse,
  AdminConnectionsResponse,
  AdminDepartment,
  AdminPeopleResponse,
  AdminInvite,
  AdminRole,
  AdminTask,
  AdminUser,
  InviteCreate,
  IssuedLink,
  JournalPage,
  LimitSettingsBody,
  ChatGptLoginDto,
  ChatGptLoginStatus,
  ModelCreate,
  ModelDto,
  ModelKeyDto,
  ModelSettings,
  ModelsResponse,
  ModelUpdate,
  SkillDto,
  SkillPreview,
  SkillsResponse,
  SkillUpdate,
  TaskCreate,
  TaskRunsResponse,
  TaskUpdate,
  PersonalLimit,
  Permission,
  PromptState,
  UsageGroup,
  UsageReport,
} from '@bba/contracts';
import { api, apiForm, apiFormPut } from '../api/client.ts';

const enc = encodeURIComponent;
// Spend of one calendar day in the installation's time zone; days without calls are 0.
export type DailySpend = { day: string; costRub: number };
type OrgProfile = { name: string; tone: string; requisites: string; industry: string };

const A = '/app/api/admin';

// A `.skill` file and, when saving a new one, the agents ticked for it.
function skillForm(file: File, agentIds?: string[]): FormData {
  const form = new FormData();
  form.append('file', file);
  if (agentIds) form.append('agentIds', JSON.stringify(agentIds));
  return form;
}
type Ok = { ok: true };

export const adminApi = {
  users: () => api<{ users: AdminUser[] }>('GET', `${A}/users`),
  people: () => api<AdminPeopleResponse>('GET', `${A}/people`),
  invites: () => api<{ invites: AdminInvite[] }>('GET', `${A}/invites`),
  invite: (input: InviteCreate) => api<IssuedLink>('POST', `${A}/invites`, input),
  revokeInvite: (id: string) => api<Ok>('POST', `${A}/invites/${enc(id)}/revoke`, {}),
  resetPassword: (userId: string) => api<IssuedLink>('POST', `${A}/password-resets`, { userId }),
  setUserRoles: (id: string, roleIds: string[]) => api<Ok>('PUT', `${A}/users/${enc(id)}/roles`, { roleIds }),
  setUserProfile: (id: string, name: string, position: string) => api<Ok>('PUT', `${A}/users/${enc(id)}/profile`, { name, position }),
  setBlocked: (id: string, blocked: boolean) => api<Ok>('POST', `${A}/users/${enc(id)}/${blocked ? 'block' : 'unblock'}`, {}),
  deleteUser: (id: string) => api<Ok>('DELETE', `${A}/users/${enc(id)}`),

  roles: () => api<{ roles: AdminRole[] }>('GET', `${A}/roles`),
  createRole: (name: string, permissions: Permission[]) => api<{ id: string }>('POST', `${A}/roles`, { name, permissions }),
  updateRole: (id: string, name: string, permissions: Permission[]) => api<Ok>('PUT', `${A}/roles/${enc(id)}`, { name, permissions }),
  deleteRole: (id: string) => api<Ok>('DELETE', `${A}/roles/${enc(id)}`),

  departments: () => api<{ departments: AdminDepartment[] }>('GET', `${A}/departments`),
  createDepartment: (name: string) => api<{ id: string }>('POST', `${A}/departments`, { name }),
  renameDepartment: (id: string, name: string) => api<Ok>('PUT', `${A}/departments/${enc(id)}`, { name }),
  deleteDepartment: (id: string) => api<Ok>('DELETE', `${A}/departments/${enc(id)}`),
  setDepartmentMembers: (id: string, userIds: string[]) => api<Ok>('PUT', `${A}/departments/${enc(id)}/members`, { userIds }),
  setDepartmentAgents: (id: string, agentIds: string[]) => api<Ok>('PUT', `${A}/departments/${enc(id)}/agents`, { agentIds }),
  setDepartmentHeads: (id: string, userIds: string[]) => api<Ok>('PUT', `${A}/departments/${enc(id)}/heads`, { userIds }),

  limits: () => api<LimitSettingsBody>('GET', `${A}/limits`),
  saveLimits: (body: LimitSettingsBody) => api<Ok>('PUT', `${A}/limits`, body),
  personalLimits: () => api<{ users: PersonalLimit[] }>('GET', `${A}/limits/users`),
  savePersonalLimit: (userId: string, monthlyRub: number | null, dailySubscriptionTokens: number | null) =>
    api<Ok>('PUT', `${A}/users/${enc(userId)}/limits`, { monthlyRub, dailySubscriptionTokens }),

  usage: (from: string, to: string, groupBy: UsageGroup) => api<UsageReport>('GET', `${A}/usage?from=${from}&to=${to}&groupBy=${groupBy}`),
  usageDaily: (from: string, to: string) => api<{ days: DailySpend[] }>('GET', `${A}/usage/daily?from=${from}&to=${to}`),

  agents: () => api<AdminAgentsResponse>('GET', `${A}/agents`),
  // MCP servers the admin adds (docs/specs/[20.11.2026]-mcp-connections.md).
  mcpServers: () => api<{ servers: McpServerView[] }>('GET', `${A}/mcp-servers`),
  mcpServer: (id: string) => api<{ server: McpServerView }>('GET', `${A}/mcp-servers/${enc(id)}`),
  probeMcp: (input: McpProbeInput) => api<McpProbeResult>('POST', `${A}/mcp-servers/probe`, input),
  createMcp: (input: McpServerInput) => api<{ server: McpServerView }>('POST', `${A}/mcp-servers`, input),
  updateMcp: (id: string, patch: McpServerPatch) => api<{ server: McpServerView }>('PATCH', `${A}/mcp-servers/${enc(id)}`, patch),
  checkMcp: (id: string, values: Record<string, string>) => api<{ server: McpServerView }>('POST', `${A}/mcp-servers/${enc(id)}/check`, { values }),
  signInMcp: (id: string) => api<{ url: string }>('POST', `${A}/mcp-servers/${enc(id)}/sign-in`, {}),
  deleteMcp: (id: string) => api<Ok>('DELETE', `${A}/mcp-servers/${enc(id)}`),
  prompt: (agentId: string) => api<PromptState>('GET', `${A}/agents/${enc(agentId)}/prompt`),
  saveDraft: (agentId: string, text: string, baseDraftVersionId: string | null) => api<{ draftVersionId: string }>('PUT', `${A}/agents/${enc(agentId)}/prompt/draft`, { text, baseDraftVersionId }),
  publish: (agentId: string) => api<Ok>('POST', `${A}/agents/${enc(agentId)}/prompt/publish`, {}),
  revert: (agentId: string) => api<Ok>('POST', `${A}/agents/${enc(agentId)}/prompt/revert`, {}),
  setModel: (agentId: string, modelId: string | null) => api<Ok>('PUT', `${A}/agents/${enc(agentId)}/model`, { modelId }),
  setStarters: (agentId: string, starters: string[] | null) => api<Ok>('PUT', `${A}/agents/${enc(agentId)}/starters`, { starters }),
  setAbilities: (agentId: string, patch: Partial<AgentAbilities>) => api<{ abilities: AgentAbilities }>('PUT', `${A}/agents/${enc(agentId)}/abilities`, patch),
  // «Доступ» and «Скиллы» of an agent (owner's decision 24.11).
  setAgentAccess: (agentId: string, access: AgentAccess) => api<{ access: AgentAccess }>('PUT', `${A}/agents/${enc(agentId)}/access`, access),
  setAgentSkills: (agentId: string, skillNames: string[]) => api<{ skillNames: string[] }>('PUT', `${A}/agents/${enc(agentId)}/skills`, { skillNames }),
  tasks: () => api<{ tasks: AdminTask[] }>('GET', `${A}/tasks`),
  approvalSettings: () => api<ApprovalSettingsDto>('GET', `${A}/approval-settings`),
  saveApprovalSettings: (body: ApprovalSettingsDto) => api<ApprovalSettingsDto>('PUT', `${A}/approval-settings`, body),
  createTask: (input: TaskCreate) => api<AdminTask>('POST', `${A}/tasks`, input),
  updateTask: (id: string, change: TaskUpdate) => api<AdminTask>('PUT', `${A}/tasks/${enc(id)}`, change),
  setTaskStatus: (id: string, status: 'active' | 'paused') => api<AdminTask>('PUT', `${A}/tasks/${enc(id)}/status`, { status }),
  deleteTask: (id: string) => api<Ok>('DELETE', `${A}/tasks/${enc(id)}`),
  taskRuns: (id: string) => api<TaskRunsResponse>('GET', `${A}/tasks/${enc(id)}/runs`),
  taskEvents: (id: string) => api<TaskEventsResponse>('GET', `${A}/tasks/${enc(id)}/events`),
  renewHook: (id: string) => api<AdminTask>('POST', `${A}/tasks/${enc(id)}/hook`, {}),
  mailReach: (agentId: string, access: TaskAccess) => api<MailReachResponse>('POST', `${A}/tasks/mail-reach`, { agentId, access }),

  models: () => api<ModelsResponse>('GET', `${A}/models`),
  createModel: (input: ModelCreate) => api<ModelDto>('POST', `${A}/models`, input),
  updateModel: (id: string, change: ModelUpdate) => api<ModelDto>('PUT', `${A}/models/${enc(id)}`, change),
  deleteModel: (id: string) => api<Ok>('DELETE', `${A}/models/${enc(id)}`),
  addModelKey: (id: string, key: string) => api<ModelKeyDto>('POST', `${A}/models/${enc(id)}/keys`, { key }),
  deleteModelKey: (id: string, keyId: string) => api<Ok>('DELETE', `${A}/models/${enc(id)}/keys/${enc(keyId)}`),
  saveModelSettings: (settings: ModelSettings) => api<ModelSettings>('PUT', `${A}/models/settings`, settings),
  startChatGptLogin: (accountId: string | null) => api<ChatGptLoginDto>('POST', `${A}/chatgpt/logins`, { accountId }),
  pollChatGptLogin: (loginId: string) => api<ChatGptLoginStatus>('GET', `${A}/chatgpt/logins/${enc(loginId)}`),
  disconnectChatGptAccount: (accountId: string) => api<Ok>('DELETE', `${A}/chatgpt/accounts/${enc(accountId)}`),

  skills: () => api<SkillsResponse>('GET', `${A}/skills`),
  checkSkill: (file: File) => apiForm<SkillPreview>(`${A}/skills?check=1`, skillForm(file)),
  createSkill: (file: File, agentIds: string[]) => apiForm<SkillDto>(`${A}/skills`, skillForm(file, agentIds)),
  replaceSkill: (name: string, file: File) => apiFormPut<SkillDto>(`${A}/skills/${enc(name)}`, skillForm(file)),
  updateSkill: (name: string, change: SkillUpdate) => api<SkillDto>('PUT', `${A}/skills/${enc(name)}`, change),
  deleteSkill: (name: string) => api<Ok>('DELETE', `${A}/skills/${enc(name)}`),

  orgProfile: () => api<OrgProfile>('GET', `${A}/org-profile`),
  saveOrgProfile: (body: OrgProfile) => api<Ok>('PUT', `${A}/org-profile`, body),
  // «Бланк, печать и подпись» (docs/specs/[20.11.2026]-org-letterhead.md).
  orgAssets: () => api<OrgAssetsState>('GET', `${A}/org-assets`),
  uploadOrgAsset: (kind: OrgAssetKind, file: Blob, name: string) => {
    const form = new FormData();
    form.append('file', file, name);
    return apiFormPut<OrgAssetsState>(`${A}/org-assets/${kind}`, form);
  },
  removeOrgAsset: (kind: OrgAssetKind) => api<OrgAssetsState>('DELETE', `${A}/org-assets/${kind}`),
  saveOrgDirector: (director: OrgDirector) => api<OrgAssetsState>('PUT', `${A}/org-director`, director),
  saveOrgSigners: (userIds: string[]) => api<OrgAssetsState>('PUT', `${A}/org-signers`, { userIds }),
  saveOrgSealMode: (withoutStamp: boolean) => api<OrgAssetsState>('PUT', `${A}/org-seal-mode`, { withoutStamp }),
  interfaceSettings: () => api<InterfaceAdminState>('GET', `${A}/interface`),
  mail: () => api<AdminMailResponse>('GET', `${A}/mail`),
  saveMailApp: (provider: MailOAuthProvider, input: MailOAuthAppInput) => api<AdminMailResponse>('PUT', `${A}/mail/oauth/${provider}`, input),
  deleteMailApp: (provider: MailOAuthProvider) => api<AdminMailResponse>('DELETE', `${A}/mail/oauth/${provider}`),
  storage: () => api<StorageStatus>('GET', `${A}/storage`),
  connectStorage: (input: StorageConnectInput) => api<StorageStatus>('POST', `${A}/storage`, input),
  storageKeys: (input: StorageKeysInput) => api<StorageStatus>('PUT', `${A}/storage/keys`, input),
  disconnectStorage: () => api<StorageStatus>('DELETE', `${A}/storage`),
  saveInterface: (change: InterfaceChange) => api<InterfaceAdminState>('PUT', `${A}/interface`, change),
  // «Значок» of an agent. The picture goes only when a new one was chosen; the one kept on the server stays otherwise.
  saveAgentMark: (agentId: string, { kind, icon, image }: { kind: AgentMarkKind; icon: AgentIcon; image: Blob | null }) => {
    const form = new FormData();
    form.append('kind', kind);
    form.append('icon', icon);
    if (image) form.append('image', image, image.type === 'image/png' ? 'agent.png' : 'agent.webp');
    return apiFormPut<AgentMarkAdminState>(`${A}/agents/${enc(agentId)}/mark`, form);
  },

  masking: () => api<{ kinds: string[] }>('GET', `${A}/masking`),
  saveMasking: (kinds: string[]) => api<Ok>('PUT', `${A}/masking`, { kinds }),

  connections: () => api<AdminConnectionsResponse>('GET', `${A}/connections`),

  journal: (q: { from: string; to: string; page: number; userId?: string; agentId?: string }) => {
    const params = new URLSearchParams({ from: q.from, to: q.to, page: String(q.page) });
    if (q.userId) params.set('userId', q.userId);
    if (q.agentId) params.set('agentId', q.agentId);
    return api<JournalPage>('GET', `${A}/journal?${params.toString()}`);
  },
};
