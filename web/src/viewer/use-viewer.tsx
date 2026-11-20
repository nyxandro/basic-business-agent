// Opening the document viewer (spec, section 8.27): the opening is a step of the browser's history at the
// same address, so «Назад» of a phone closes the viewer instead of leaving the chat; «×» and Esc go back the
// same step. After a reload the viewer is closed. `channel` — the chat the viewer was opened from: its marks go
// there (spec, section 8.32); given at every render, so the viewer knows whether the agent answers now.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { DocumentViewer, type ViewerSource } from './DocumentViewer.tsx';
import type { MarksChannel } from './marks/types.ts';

interface ViewerState {
  documentViewer?: string;
}

export function useDocumentViewer(channel: MarksChannel | null = null): { open: (source: ViewerSource) => void; viewer: ReactNode } {
  const navigate = useNavigate();
  const location = useLocation();
  const [opened, setOpened] = useState<{ key: string; source: ViewerSource } | null>(null);
  const current = (location.state as ViewerState | null)?.documentViewer;
  const shown = opened && current === opened.key ? opened : null;
  // The viewer at this step of the history now: closing goes back only from its own step — once, whatever closes it
  // («×», Esc, the dimmed page, the end of sending marks after «Назад» of a phone).
  const step = useRef(current);
  useLayoutEffect(() => {
    step.current = current;
  });

  const open = (source: ViewerSource) => {
    // A second press while the viewer opens does not open another one over it.
    if (shown) return;
    const key = crypto.randomUUID();
    setOpened({ key, source });
    void navigate({ pathname: location.pathname, search: location.search, hash: location.hash }, { state: { ...((location.state as object | null) ?? {}), documentViewer: key } });
  };

  return {
    open,
    viewer: shown ? (
      <DocumentViewer
        source={shown.source}
        channel={channel}
        onClose={() => {
          setOpened(null);
          if (step.current !== shown.key) return;
          step.current = undefined;
          void navigate(-1);
        }}
      />
    ) : null,
  };
}
