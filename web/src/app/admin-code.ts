// The code of the admin panel is a piece of its own (the employees without rights never load it); for
// those with rights it is loaded in the background after the start, so a click opens it at once (spec,
// section 8.22).
export const loadAdminCode = () => import('../admin/AdminRoutes.tsx');

export function preloadAdminCode(): void {
  const load = () => void loadAdminCode();
  // When the browser is idle; one without the idle callback (Safari) — right after the current work.
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(load);
  else window.setTimeout(load, 0);
}
