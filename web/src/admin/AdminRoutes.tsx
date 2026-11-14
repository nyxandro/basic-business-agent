// The admin panel's routes, loaded only when someone opens it (React.lazy in App.tsx): employees
// never download its code.
import { Route, Routes } from 'react-router';
import { AdminIndex, AdminLayout, RequireSection } from './AdminLayout.tsx';
import { AgentsSection } from './AgentsSection.tsx';
import { ConnectionsSection } from './ConnectionsSection.tsx';
import { DepartmentsSection } from './DepartmentsSection.tsx';
import { DraftCheckPage } from './DraftCheckPage.tsx';
import { JournalSection } from './JournalSection.tsx';
import { LimitsPage } from './LimitsPage.tsx';
import { MaskingSection } from './MaskingSection.tsx';
import { OrgProfileSection } from './OrgProfileSection.tsx';
import { RolesSection } from './RolesSection.tsx';
import { UsersSection } from './UsersSection.tsx';

export default function AdminRoutes() {
  return (
    <Routes>
      <Route element={<AdminLayout />}>
        <Route index element={<AdminIndex />} />
        <Route path="users" element={<RequireSection path="users"><UsersSection /></RequireSection>} />
        <Route path="roles" element={<RequireSection path="roles"><RolesSection /></RequireSection>} />
        <Route path="departments" element={<RequireSection path="departments"><DepartmentsSection /></RequireSection>} />
        <Route path="limits" element={<RequireSection path="limits"><LimitsPage /></RequireSection>} />
        <Route path="agents" element={<RequireSection path="agents"><AgentsSection /></RequireSection>} />
        <Route path="agents/:agentId/check" element={<RequireSection path="agents"><DraftCheckPage /></RequireSection>} />
        <Route path="org-profile" element={<RequireSection path="org-profile"><OrgProfileSection /></RequireSection>} />
        <Route path="masking" element={<RequireSection path="masking"><MaskingSection /></RequireSection>} />
        <Route path="connections" element={<RequireSection path="connections"><ConnectionsSection /></RequireSection>} />
        <Route path="journal" element={<RequireSection path="journal"><JournalSection /></RequireSection>} />
      </Route>
    </Routes>
  );
}
