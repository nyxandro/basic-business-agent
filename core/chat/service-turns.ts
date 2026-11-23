// Messages the server writes into a conversation on the person's behalf to start a turn of the agent: the outcome of an
// agreed request (core/chat/chain-continuation.ts). They are not the person's words: the chat does not show them, and the
// number of a turn (a complaint, docs/specs/[20.11.2026]-feedback-and-value.md) counts only what the person wrote —
// the same live and after a reload.
export const CHAIN_OUTCOME_PREFIX = '[Итог согласования ';

export const isServiceTurn = (text: string): boolean => text.startsWith(CHAIN_OUTCOME_PREFIX);
