import type { AgentSummary } from '@bba/contracts';

// The system a tool works in («Заметки», «Битрикс24»): exact plugin tools first, then connected
// systems by name prefix. Null for the agent's own tools.
export function systemOf(systems: AgentSummary['systems'], toolName: string): string | null {
  const exact = systems.tools[toolName];
  if (exact) return exact;
  const prefix = Object.keys(systems.prefixes).find((p) => toolName.startsWith(p));
  return prefix ? systems.prefixes[prefix]! : null;
}
