// The heart of samples in the chat (docs/specs/[20.11.2026]-feedback-and-value.md, F6; owner 24.11): on a document the
// agent made only while «Интерфейс» allows it (off in a new installation), and never in the check of a prompt's draft.
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { ChatExtrasContext, type ChatExtras } from '../answer/chat-context.ts';
import { RequireAuth, SessionProvider } from '../auth/session.tsx';
import { ME, mockServer } from '../test/fetch-mock.ts';
import { ToastProvider } from '../ui/Toast.tsx';
import { FileOfCall } from './renderers.tsx';

const DOCUMENT = {
  toolCallId: 'c1',
  status: 'complete' as const,
  parameters: { path: 'КП.docx' },
  result: JSON.stringify({ shown: true, path: 'КП.docx', name: 'КП.docx', bytes: 2048, made: true }),
};

function chatWith({ samples, draft }: { samples: boolean; draft: boolean }) {
  mockServer({
    'GET /app/api/me': { body: { ...ME, interface: { ...ME.interface, documentSamples: samples } } },
    'GET /app/api/me/examples': { body: { bases: [], saved: [] } },
  });
  // Only what the file block reads of the conversation.
  const extras = { threadId: 't1', draft } as ChatExtras;
  return render(
    <MemoryRouter>
      <SessionProvider>
        <ToastProvider>
          <RequireAuth>
            <ChatExtrasContext value={extras}>
              <FileOfCall call={DOCUMENT} />
            </ChatExtrasContext>
          </RequireAuth>
        </ToastProvider>
      </SessionProvider>
    </MemoryRouter>,
  );
}

describe('the heart of samples in the chat', () => {
  it('is on a document of the agent while «Интерфейс» allows it, never in the check of a draft', async () => {
    const allowed = chatWith({ samples: true, draft: false });
    expect(await screen.findByRole('button', { name: 'Добавить в референсы: КП.docx' })).toBeInTheDocument();
    allowed.unmount();
    for (const setting of [{ samples: false, draft: false }, { samples: true, draft: true }]) {
      const view = chatWith(setting);
      expect(await screen.findByRole('button', { name: 'Открыть КП.docx' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /референс/ })).not.toBeInTheDocument();
      view.unmount();
    }
  });
});
