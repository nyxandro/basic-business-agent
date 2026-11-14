// Routes of the interface (spec, section 7). Public: sign-in and the password links.
import { CopilotKit } from '@copilotkit/react-core';
import { Navigate, Route, Routes } from 'react-router';
import { AgentsPage } from '../agents/AgentsPage.tsx';
import { LoginPage } from '../auth/LoginPage.tsx';
import { ChatPage } from '../chat/ChatPage.tsx';
import { PasswordLinkPage } from '../auth/PasswordLinkPage.tsx';
import { RequireAuth, SessionProvider } from '../auth/session.tsx';
import { AppLayout } from '../layout/AppLayout.tsx';
import { COPILOT_PRIVACY, COPILOT_RUNTIME_URL } from './copilot.ts';
import { AdminIndex, AdminLayout, RequireSection } from '../admin/AdminLayout.tsx';
import { AgentsSection } from '../admin/AgentsSection.tsx';
import { ConnectionsSection } from '../admin/ConnectionsSection.tsx';
import { DepartmentsSection } from '../admin/DepartmentsSection.tsx';
import { DraftCheckPage } from '../admin/DraftCheckPage.tsx';
import { JournalSection } from '../admin/JournalSection.tsx';
import { LimitsSection } from '../admin/LimitsSection.tsx';
import { MaskingSection } from '../admin/MaskingSection.tsx';
import { OrgProfileSection } from '../admin/OrgProfileSection.tsx';
import { RolesSection } from '../admin/RolesSection.tsx';
import { UsageSection } from '../admin/UsageSection.tsx';
import { UsersSection } from '../admin/UsersSection.tsx';
import { ApprovalsPage } from '../approvals/ApprovalsPage.tsx';
import { ConnectionsPage } from '../settings/ConnectionsPage.tsx';
import { MemoryPage } from '../settings/MemoryPage.tsx';
import { SettingsLayout } from '../settings/SettingsLayout.tsx';
import { UsagePage } from '../settings/UsagePage.tsx';


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
          <Route path="approvals" element={<ApprovalsPage />} />
          <Route path="settings" element={<SettingsLayout />}>
            <Route index element={<Navigate to="memory" replace />} />
            <Route path="memory" element={<MemoryPage />} />
            <Route path="usage" element={<UsagePage />} />
            <Route path="connections" element={<ConnectionsPage />} />
          </Route>
          <Route path="admin" element={<AdminLayout />}>
            <Route index element={<AdminIndex />} />
            <Route path="users" element={<RequireSection section="users"><UsersSection /></RequireSection>} />
            <Route path="roles" element={<RequireSection section="roles"><RolesSection /></RequireSection>} />
            <Route path="departments" element={<RequireSection section="departments"><DepartmentsSection /></RequireSection>} />
            <Route path="limits" element={<RequireSection section="limits"><LimitsSection /></RequireSection>} />
            <Route path="usage" element={<RequireSection section="usage"><UsageSection /></RequireSection>} />
            <Route path="agents" element={<RequireSection section="agents"><AgentsSection /></RequireSection>} />
            <Route path="agents/:agentId/check" element={<RequireSection section="agents"><DraftCheckPage /></RequireSection>} />
            <Route path="org-profile" element={<RequireSection section="org_profile"><OrgProfileSection /></RequireSection>} />
            <Route path="masking" element={<RequireSection section="masking"><MaskingSection /></RequireSection>} />
            <Route path="connections" element={<RequireSection section="connections"><ConnectionsSection /></RequireSection>} />
            <Route path="journal" element={<RequireSection section="journal"><JournalSection /></RequireSection>} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </SessionProvider>
  );
}
