// MCP servers the admin adds (docs/specs/[20.11.2026]-mcp-connections.md): the form of the admin and what
// the admin panel shows. Secrets go in only: the view tells whether they are set, never their values.
import { z } from 'zod';

export const MCP_AUTH_KINDS = ['none', 'oauth', 'personal_key', 'shared_key'] as const;
export type McpAuthKind = (typeof MCP_AUTH_KINDS)[number];

export const MCP_TRANSPORTS = ['http', 'program'] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

// A program server runs in the sandbox container only with these runners (the owner's decision 21.11).
export const MCP_PROGRAM_RUNNERS = ['npx', 'uvx'] as const;
export type McpProgramRunner = (typeof MCP_PROGRAM_RUNNERS)[number];

export const MCP_SERVER_STATUSES = ['draft', 'enabled', 'disabled', 'shared_auth_error', 'program_crashed'] as const;
export type McpServerStatus = (typeof MCP_SERVER_STATUSES)[number];

export const MCP_TITLE_MAX = 80;
export const MCP_FIELDS_MAX = 10;

// A value of a field — a key, a portal name: it goes into an address or a header, so no line breaks.
export const mcpFieldValueSchema = z
  .string()
  .min(1)
  .max(4000)
  .refine((value) => !/[\r\n\0]/.test(value), { message: 'a value of a field holds no line breaks' });

// A value the admin asks each employee for (a personal key) or fills in once (a shared key).
export const mcpFieldSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  label: z.string().trim().min(1).max(60),
  hint: z.string().trim().max(300),
  secret: z.boolean(),
});
export type McpField = z.infer<typeof mcpFieldSchema>;

export const mcpProgramSchema = z.object({
  runner: z.enum(MCP_PROGRAM_RUNNERS),
  package: z.string().trim().min(1).max(200),
  args: z.array(z.string().max(500)).max(30),
});
export type McpProgram = z.infer<typeof mcpProgramSchema>;

export const mcpServerInputSchema = z.object({
  title: z.string().trim().min(1).max(MCP_TITLE_MAX),
  transport: z.enum(MCP_TRANSPORTS),
  url: z.string().trim().min(1).max(2000).nullable(),
  program: mcpProgramSchema.nullable(),
  auth: z.enum(MCP_AUTH_KINDS),
  fields: z.array(mcpFieldSchema).max(MCP_FIELDS_MAX),
  // Header name → template with {{field}}; only for a server by address.
  headers: z.record(z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/), z.string().max(2000)),
  // Environment variable → template with {{field}}; only for a program.
  env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/), z.string().max(2000)),
  // The values of a shared key, entered once by the admin.
  sharedValues: z.record(z.string(), mcpFieldValueSchema).nullable(),
  // The app the admin registered in the system for its sign-in (when the system does not register apps itself).
  client: z.object({ clientId: z.string().trim().min(1).max(500), clientSecret: z.string().min(1).max(2000).optional() }).nullable(),
});
export type McpServerInput = z.infer<typeof mcpServerInputSchema>;

// One action of the server as the admin checked it.
export interface McpAction {
  // The server's own name (`crm.deal.list`); rules of approvals refer to it.
  name: string;
  // What the model sees: `^[a-zA-Z0-9_-]{1,64}$`.
  modelName: string;
  // The title for people the admin gave; null — the server's title is shown.
  title: string | null;
  // The server's own title, or its name when it gives none.
  serverTitle: string;
  description: string;
  enabled: boolean;
  readOnly: boolean;
  // The server says the action only reads; a hint for the admin, never applied by itself.
  readOnlyHint: boolean;
  // The admin chose it to check a personal key.
  check: boolean;
  // Appeared in a later snapshot and is not looked at yet.
  isNew: boolean;
  // The server changed its description or parameters since the admin last saved the actions.
  isChanged: boolean;
  // About how many tokens the action adds to every request of an agent that has it.
  tokens: number;
}

export const MCP_ACTIONS_MAX = 500;

// What the admin sets on one action (scenario 1, «Действия и агенты»).
export const mcpActionPatchSchema = z.object({
  name: z.string().min(1).max(500),
  enabled: z.boolean(),
  readOnly: z.boolean(),
  title: z.string().trim().max(MCP_TITLE_MAX).nullable(),
  check: z.boolean(),
});
export type McpActionPatch = z.infer<typeof mcpActionPatchSchema>;

// «Изменить» (scenario 5). The address, the way of sign-in and the keys of fields change only while the server is
// a draft (`definition`); later — the title, the labels of fields, the shared key, the actions, the agents, on/off.
export const mcpServerPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(MCP_TITLE_MAX),
    fields: z.array(mcpFieldSchema).max(MCP_FIELDS_MAX),
    sharedValues: z.record(z.string(), mcpFieldValueSchema),
    actions: z.array(mcpActionPatchSchema).max(MCP_ACTIONS_MAX),
    agents: z.array(z.string().min(1).max(100)).max(100),
    status: z.enum(['enabled', 'disabled']),
    definition: mcpServerInputSchema,
  })
  .partial();
export type McpServerPatch = z.infer<typeof mcpServerPatchSchema>;

// «Проверить своим доступом» for a personal key: the admin's own values, used for the check and not kept.
export const mcpCheckInputSchema = z.object({ values: z.record(z.string(), mcpFieldValueSchema) });
export type McpCheckInput = z.infer<typeof mcpCheckInputSchema>;

export interface McpServerView {
  id: string;
  slug: string;
  title: string;
  transport: McpTransport;
  url: string | null;
  program: McpProgram | null;
  auth: McpAuthKind;
  fields: McpField[];
  headers: Record<string, string>;
  env: Record<string, string>;
  clientId: string | null;
  clientSecretSet: boolean;
  sharedConfigured: boolean;
  status: McpServerStatus;
  statusErrorCode: string | null;
  actions: McpAction[];
  snapshotAt: string | null;
  agents: string[];
  createdAt: string;
  updatedAt: string;
}

// What an address tells about itself before the admin fills the form (spec, scenario 1): a server without
// sign-in, one with a sign-in on the system's site, or one that takes a key (it refuses and names no sign-in).
export const MCP_PROBE_AUTH = ['none', 'oauth', 'key'] as const;
export type McpProbeAuth = (typeof MCP_PROBE_AUTH)[number];

// An address may carry {{field}} (a key in the path, as at МойСклад): the admin's value is needed to check it.
export const mcpProbeInputSchema = z.object({
  url: z.string().trim().min(1).max(2000),
  fields: z.array(mcpFieldSchema).max(MCP_FIELDS_MAX),
  values: z.record(z.string(), mcpFieldValueSchema),
});
export type McpProbeInput = z.infer<typeof mcpProbeInputSchema>;

export interface McpProbeResult {
  auth: McpProbeAuth;
}
