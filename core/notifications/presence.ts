// «The person is in the app» (docs/specs/[20.11.2026]-notifications.md, section 8): a visible tab says so every 30 s, a
// hidden one says «hidden» at once. Somebody whose tab — on any device — was seen visible less than a minute ago gets
// no push: the page shows the news itself. The marks live in the memory of the one server process of an installation,
// like the holds of the file storage (spec of the base, 8.23): they matter for a minute.
export const PRESENCE_TTL_MS = 60_000;
// Tabs of one person kept at once: a page that makes new ids (a script) never fills the memory of the server.
export const TABS_PER_PERSON = 20;

export interface Presence {
  seen(userId: string, tab: string, visible: boolean): void;
  isHere(userId: string): boolean;
}

export function createPresence(clock: () => number = Date.now): Presence {
  const tabs = new Map<string, Map<string, number>>();

  function fresh(userId: string): Map<string, number> | undefined {
    const own = tabs.get(userId);
    if (!own) return undefined;
    const now = clock();
    for (const [tab, at] of own) if (now - at >= PRESENCE_TTL_MS) own.delete(tab);
    if (own.size === 0) tabs.delete(userId);
    return own.size > 0 ? own : undefined;
  }

  return {
    seen(userId, tab, visible) {
      if (!visible) {
        const own = tabs.get(userId);
        own?.delete(tab);
        if (own?.size === 0) tabs.delete(userId);
        return;
      }
      const own = fresh(userId) ?? new Map<string, number>();
      own.delete(tab);
      own.set(tab, clock());
      // A Map keeps the order of setting: the first key is the tab seen longest ago.
      while (own.size > TABS_PER_PERSON) own.delete(own.keys().next().value!);
      tabs.set(userId, own);
    },
    isHere: (userId) => fresh(userId) !== undefined,
  };
}
