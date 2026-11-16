// GET /app/api/search (spec, section 8.13): the person's own projects and conversations.
import type { SearchResponse, SearchScope } from '@bba/contracts';
import { api } from '../api/client.ts';

export function searchAll(q: string, scope: SearchScope): Promise<SearchResponse> {
  const params = new URLSearchParams({ q, scope });
  return api<SearchResponse>('GET', `/app/api/search?${params.toString()}`);
}
