// Routes of the interface (spec, section 7). Public: sign-in and the password links.
import { CopilotKit } from '@copilotkit/react-core';
import { Navigate, Route, Routes } from 'react-router';
import { AgentsPage } from '../agents/AgentsPage.tsx';
import { LoginPage } from '../auth/LoginPage.tsx';
import { ChatPage } from '../chat/ChatPage.tsx';
import { PasswordLinkPage } from '../auth/PasswordLinkPage.tsx';
import { RequireAuth, SessionProvider } from '../auth/session.tsx';
import { AppLayout } from '../layout/AppLayout.tsx';

// The CopilotKit runtime of the server (core/chat/copilot.ts); the session cookie goes with it.
export const COPILOT_RUNTIME_URL = '/app/api/copilotkit';

// The development Inspector of CopilotKit sends usage events to telemetry.copilotkit.ai and loads
// fonts from Google; the Intelligence indicator belongs to their cloud. Employees' browsers of a
// closed installation talk only to our server, so both stay off in every build.
const COPILOT_PRIVACY = { enableInspector: false, showIntelligenceIndicator: false } as const;

export function App() {
  return (
    <SessionProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/invite/:token" element={<PasswordLinkPage kind="invite" />} />
        <Route path="/reset/:token" element={<PasswordLinkPage kind="reset" />} />
        <Route
          element={
            <RequireAuth>
              <CopilotKit runtimeUrl={COPILOT_RUNTIME_URL} credentials="same-origin" {...COPILOT_PRIVACY}>
                <AppLayout />
              </CopilotKit>
            </RequireAuth>
          }
        >
          <Route index element={<AgentsPage />} />
          <Route path="agents/:agentId" element={<ChatPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </SessionProvider>
  );
}
