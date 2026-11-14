// Routes of the interface (spec, section 7). Public: sign-in and the password links. The admin
// panel is a separate piece of code, loaded when it is opened.
import { CopilotKit } from '@copilotkit/react-core';
import { lazy, Suspense } from 'react';
import { Navigate, Outlet, Route, Routes } from 'react-router';
import { ApprovalsPage } from '../approvals/ApprovalsPage.tsx';
import { LoginPage } from '../auth/LoginPage.tsx';
import { PasswordLinkPage } from '../auth/PasswordLinkPage.tsx';
import { RequireAuth, SessionProvider } from '../auth/session.tsx';
import { ChatPage } from '../chat/ChatPage.tsx';
import { AppShell, Home } from '../layout/AppShell.tsx';
import { ConnectionsPage } from '../settings/ConnectionsPage.tsx';
import { MemoryPage } from '../settings/MemoryPage.tsx';
import { UsagePage } from '../settings/UsagePage.tsx';
import { Skeleton } from '../ui/Loading.tsx';
import { ThemeProvider } from '../ui/theme/ThemeProvider.tsx';
import { ConfirmProvider } from '../ui/Confirm.tsx';
import { ToastProvider } from '../ui/Toast.tsx';
import { COPILOT_OPTIONS } from './copilot.ts';

const AdminRoutes = lazy(() => import('../admin/AdminRoutes.tsx'));
const ProjectPage = lazy(() => import('../projects/ProjectPage.tsx').then((m) => ({ default: m.ProjectPage })));

export function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <ConfirmProvider>
        <SessionProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/invite/:token" element={<PasswordLinkPage kind="invite" />} />
            <Route path="/reset/:token" element={<PasswordLinkPage kind="reset" />} />
            <Route
              element={
                <RequireAuth>
                  <CopilotKit {...COPILOT_OPTIONS}>
                    <Outlet />
                  </CopilotKit>
                </RequireAuth>
              }
            >
              {/* The admin panel has its own frame (mockup «Админка»). */}
              <Route
                path="admin/*"
                element={
                  <Suspense fallback={<Skeleton rows={4} />}>
                    <AdminRoutes />
                  </Suspense>
                }
              />
              <Route element={<AppShell />}>
                <Route index element={<Home />} />
                <Route path="agents/:agentId" element={<ChatPage />} />
                <Route
                  path="projects/:projectId"
                  element={
                    <Suspense fallback={<Skeleton rows={4} />}>
                      <ProjectPage />
                    </Suspense>
                  }
                />
                <Route path="approvals" element={<ApprovalsPage />} />
                <Route path="settings">
                  <Route index element={<Navigate to="memory" replace />} />
                  <Route path="memory" element={<MemoryPage />} />
                  <Route path="usage" element={<UsagePage />} />
                  <Route path="connections" element={<ConnectionsPage />} />
                </Route>
              </Route>
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </SessionProvider>
        </ConfirmProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
