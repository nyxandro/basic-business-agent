// What the confirmation card says about an action (spec, section 8.4): the name of the action and
// the labels of its fields come from the tool itself — the first sentence of a Mastra tool's
// `description` (or an MCP tool's `title`) and the `.describe()` of its input fields. No retelling
// by the model.
import type { ActionDescription } from '@bba/contracts';
import type { AnyTool } from '../plugins/public/index.ts';

const TITLE_MAX = 120;

interface Described {
  id?: unknown;
  requireApproval?: unknown;
  title?: unknown;
  description?: unknown;
  inputSchema?: unknown;
}

function firstSentence(text: string): string {
  const sentence = text.trim().split(/(?<=[.!?])\s|\n/)[0]!.replace(/[.!?]$/, '').trim();
  return sentence.length > TITLE_MAX ? `${sentence.slice(0, TITLE_MAX - 1)}…` : sentence;
}

// Zod objects keep a field's description on the field; an MCP tool may bring a JSON schema.
export function fieldsOf(schema: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const shape = (schema as { shape?: Record<string, { description?: unknown }> } | undefined)?.shape;
  const properties = (schema as { jsonSchema?: { properties?: Record<string, { description?: unknown; title?: unknown }> }; properties?: Record<string, { description?: unknown; title?: unknown }> } | undefined);
  const json = properties?.jsonSchema?.properties ?? properties?.properties;
  for (const [field, def] of Object.entries(shape ?? json ?? {})) {
    const d = def as { description?: unknown; title?: unknown };
    const label = typeof d.title === 'string' && d.title ? d.title : typeof d.description === 'string' ? d.description : '';
    if (label.trim()) out[field] = firstSentence(label);
  }
  return out;
}

export function describeTool(tool: AnyTool): ActionDescription {
  const t = tool as unknown as Described;
  const title = typeof t.title === 'string' && t.title.trim() ? t.title.trim() : typeof t.description === 'string' && t.description.trim() ? firstSentence(t.description) : String(t.id);
  // Tools pass applyApprovalPolicy, which asks «Да» for everything but the read-only ones; a read-only one asks only
  // while a rule of multi-step approvals is on it (a function decides at the call).
  return { title, fields: fieldsOf(t.inputSchema), readOnly: t.requireApproval === false || typeof t.requireApproval === 'function' };
}

export function describeTools(tools: Record<string, AnyTool>): Record<string, ActionDescription> {
  return Object.fromEntries(Object.entries(tools).map(([name, tool]) => [name, describeTool(tool)]));
}

interface AgentTools {
  tools: Record<string, AnyTool>;
  subagents: AgentTools[];
}

// The chat line of a call of a sub-agent: Mastra names that tool `agent-<id of the sub-agent>`.
// The sub-agent's own actions ask «Да» themselves, so the call is no read-only action.
export function subagentCalls(rt: { subagents: { passport: { id: string; name: string } }[] }): Record<string, ActionDescription> {
  return Object.fromEntries(rt.subagents.map((s) => [`agent-${s.passport.id}`, { title: `Поручение агенту «${s.passport.name}»`, fields: {}, readOnly: false }]));
}

// Actions of an agent and of its sub-agents: a sub-agent's question reaches its parent's chat.
export function agentActions(rt: AgentTools): Record<string, ActionDescription> {
  return Object.assign({}, ...rt.subagents.map(agentActions), describeTools(rt.tools)) as Record<string, ActionDescription>;
}
