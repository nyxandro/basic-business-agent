// Agents open to the person (GET /app/api/agents): what the chat list shows on its cards.
export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  starters: string[];
}

export interface AgentListResponse {
  agents: AgentSummary[];
}
