// Routes of the interface (spec, section 7). Public: sign-in and the password links. The admin
// panel is a separate piece of code, loaded in the background for those with rights (admin-code.ts).
import { CopilotKit } from '@copilotkit/react-core';
import { WIDGETS_CONFIG } from '../widgets/catalog.ts';
import { lazy, Suspense } from 'react';
import { Navigate, Outlet, Route, Routes } from 'react-router';
import { ErrorBoundary } from '../ui/ErrorBoundary.tsx';
import { ApprovalsPage } from '../approvals/ApprovalsPage.tsx';
import { ArchivePage } from '../projects/ArchivePage.tsx';
import { ProjectPage } from '../projects/ProjectPage.tsx';
import { LoginPage } from '../auth/LoginPage.tsx';
import { PasswordLinkPage } from '../auth/PasswordLinkPage.tsx';
import { RequireAuth, SessionProvider } from '../auth/session.tsx';
import { ChatPage } from '../chat/ChatPage.tsx';
import { AppShell, Home } from '../layout/AppShell.tsx';
import { ConnectionsPage } from '../settings/ConnectionsPage.tsx';
import { NotificationsPage } from '../settings/NotificationsPage.tsx';
import { MemoryPage } from '../settings/MemoryPage.tsx';
import { UsagePage } from '../settings/UsagePage.tsx';
import { DelayedBar } from '../ui/Loading.tsx';
import { loadAdminCode } from './admin-code.ts';
import { ThemeProvider } from '../ui/theme/ThemeProvider.tsx';
import { ConfirmProvider } from '../ui/Confirm.tsx';
import { ToastProvider } from '../ui/Toast.tsx';
import { COPILOT_OPTIONS } from './copilot.ts';

const AdminRoutes = lazy(loadAdminCode);

export function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <ConfirmProvider>
        <SessionProvider>
          <ErrorBoundary>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/invite/:token" element={<PasswordLinkPage kind="invite" />} />
              <Route path="/reset/:token" element={<PasswordLinkPage kind="reset" />} />
              <Route
                element={
                  <RequireAuth>
                    <CopilotKit {...COPILOT_OPTIONS} generativeUI={WIDGETS_CONFIG}>
                      <Outlet />
                    </CopilotKit>
                  </RequireAuth>
                }
              >
                {/* The admin panel has its own frame (mockup «Админка»). */}
                <Route
                  path="admin/*"
                  element={
                    <Suspense fallback={<DelayedBar />}>
                      <AdminRoutes />
                    </Suspense>
                  }
                />
                <Route element={<AppShell />}>
                  <Route index element={<Home />} />
                  <Route path="agents/:agentId" element={<ChatPage />} />
                  <Route path="projects/archive" element={<ArchivePage />} />
                  <Route path="projects/:projectId" element={<ProjectPage />} />
                  <Route path="approvals" element={<ApprovalsPage />} />
                  <Route path="settings">
                    <Route index element={<Navigate to="memory" replace />} />
                    <Route path="memory" element={<MemoryPage />} />
                    <Route path="usage" element={<UsagePage />} />
                    <Route path="connections" element={<ConnectionsPage />} />
                    <Route path="notifications" element={<NotificationsPage />} />
                  </Route>
                </Route>
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </ErrorBoundary>
        </SessionProvider>
        </ConfirmProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
