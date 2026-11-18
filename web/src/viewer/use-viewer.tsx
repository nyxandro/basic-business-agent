// Opening the document viewer (spec, section 8.27): the opening is a step of the browser's history at the
// same address, so «Назад» of a phone closes the viewer instead of leaving the chat; «×» and Esc go back the
// same step. After a reload the viewer is closed.
import { useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { DocumentViewer, type ViewerSource } from './DocumentViewer.tsx';

interface ViewerState {
  documentViewer?: string;
}

export function useDocumentViewer(): { open: (source: ViewerSource) => void; viewer: ReactNode } {
  const navigate = useNavigate();
  const location = useLocation();
  const [opened, setOpened] = useState<{ key: string; source: ViewerSource } | null>(null);
  const shown = opened && (location.state as ViewerState | null)?.documentViewer === opened.key ? opened : null;

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
        onClose={() => {
          setOpened(null);
          void navigate(-1);
        }}
      />
    ) : null,
  };
}
