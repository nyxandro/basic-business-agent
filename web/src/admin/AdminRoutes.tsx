// The admin panel's routes, loaded only when someone opens it (React.lazy in App.tsx): employees
// never download its code.
import { Route, Routes } from 'react-router';
import { AdminIndex, AdminLayout, RequireSection } from './AdminLayout.tsx';
import { AgentsSection } from './AgentsSection.tsx';
import { ConnectionsSection } from './ConnectionsSection.tsx';
import { DepartmentsSection } from './DepartmentsSection.tsx';
import { DraftCheckPage } from './DraftCheckPage.tsx';
import { JournalSection } from './JournalSection.tsx';
import { LimitsSection } from './LimitsSection.tsx';
import { MaskingSection } from './MaskingSection.tsx';
import { OrgProfileSection } from './OrgProfileSection.tsx';
import { RolesSection } from './RolesSection.tsx';
import { UsageSection } from './UsageSection.tsx';
import { UsersSection } from './UsersSection.tsx';

export default function AdminRoutes() {
  return (
    <Routes>
      <Route element={<AdminLayout />}>
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
    </Routes>
  );
}
