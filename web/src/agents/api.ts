import type { AgentListResponse } from '@bba/contracts';
import { api } from '../api/client.ts';

export const fetchAgents = () => api<AgentListResponse>('GET', '/app/api/agents');
