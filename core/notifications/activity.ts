// Where an agent works right now (decision of the owner 22.11: a turning blue ring at the conversation in the lists):
// an answer of the chat from its start to the end of the agent, a background run, the continuation after «Да». Kept in
// the memory of the one server process, like presence; every change tells the person's pages at once.
export interface Activity {
  // Returns how to mark the end; a second call of it does nothing.
  start(userId: string, threadId: string): () => void;
  running(userId: string): ReadonlySet<string>;
}

export function createActivity(changed: (userId: string) => void): Activity {
  // How many runs work in each conversation of a person (an answer and a continuation after «Да» may overlap).
  const runs = new Map<string, Map<string, number>>();
  return {
    start(userId, threadId) {
      const own = runs.get(userId) ?? new Map<string, number>();
      own.set(threadId, (own.get(threadId) ?? 0) + 1);
      runs.set(userId, own);
      changed(userId);
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        const left = (own.get(threadId) ?? 1) - 1;
        if (left > 0) own.set(threadId, left);
        else own.delete(threadId);
        if (own.size === 0 && runs.get(userId) === own) runs.delete(userId);
        changed(userId);
      };
    },
    running: (userId) => new Set(runs.get(userId)?.keys() ?? []),
  };
}
