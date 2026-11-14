// The text being typed survives a reload and an expired session (spec, section 10): it is kept in
// this browser per conversation until it is sent. Storage may be unavailable (private mode).
const key = (agentId: string, threadId: string) => `bba:draft:${agentId}:${threadId}`;

export function readDraft(agentId: string, threadId: string): string {
  try {
    return localStorage.getItem(key(agentId, threadId)) ?? '';
  } catch {
    return '';
  }
}

export function writeDraft(agentId: string, threadId: string, text: string): void {
  try {
    if (text) localStorage.setItem(key(agentId, threadId), text);
    else localStorage.removeItem(key(agentId, threadId));
  } catch {
    // Without storage the draft lives only in the field; nothing else to do.
  }
}
