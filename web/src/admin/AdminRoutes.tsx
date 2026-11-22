// The admin panel's routes, loaded only when someone opens it (React.lazy in App.tsx): employees
// never download its code.
import { Route, Routes } from 'react-router';
import { AdminIndex, AdminLayout, RequireSection } from './AdminLayout.tsx';
import { AgentPage } from './AgentPage.tsx';
import { AgentsSection } from './AgentsSection.tsx';
import { ConnectionsSection } from './ConnectionsSection.tsx';
import { DepartmentsSection } from './DepartmentsSection.tsx';
import { DraftCheckPage } from './DraftCheckPage.tsx';
import { InterfaceSection } from './InterfaceSection.tsx';
import { JournalSection } from './JournalSection.tsx';
import { LimitsPage } from './LimitsPage.tsx';
import { MaskingSection } from './MaskingSection.tsx';
import { ModelsSection } from './ModelsSection.tsx';
import { ModesSection } from './ModesSection.tsx';
import { OrgProfileSection } from './OrgProfileSection.tsx';
import { RolesSection } from './RolesSection.tsx';
import { SkillsSection } from './SkillsSection.tsx';
import { StorageSection } from './StorageSection.tsx';
import { UsersSection } from './UsersSection.tsx';
import { ApprovalRules } from './ApprovalRules.tsx';

export default function AdminRoutes() {
  return (
    <Routes>
      <Route element={<AdminLayout />}>
        <Route index element={<AdminIndex />} />
        <Route path="models" element={<RequireSection path="models"><ModelsSection /></RequireSection>} />
        <Route path="modes" element={<RequireSection path="modes"><ModesSection /></RequireSection>} />
        <Route path="approval-rules" element={<RequireSection path="approval-rules"><ApprovalRules /></RequireSection>} />
        <Route path="users" element={<RequireSection path="users"><UsersSection /></RequireSection>} />
        <Route path="roles" element={<RequireSection path="roles"><RolesSection /></RequireSection>} />
        <Route path="departments" element={<RequireSection path="departments"><DepartmentsSection /></RequireSection>} />
        <Route path="limits" element={<RequireSection path="limits"><LimitsPage /></RequireSection>} />
        <Route path="skills" element={<RequireSection path="skills"><SkillsSection /></RequireSection>} />
        <Route path="agents" element={<RequireSection path="agents"><AgentsSection /></RequireSection>} />
        {/* One route for the sections of an agent: switching them keeps the page and its unsaved edits. */}
        <Route path="agents/:agentId/:tab?" element={<RequireSection path="agents"><AgentPage /></RequireSection>} />
        <Route path="agents/:agentId/check" element={<RequireSection path="agents"><DraftCheckPage /></RequireSection>} />
        <Route path="org-profile" element={<RequireSection path="org-profile"><OrgProfileSection /></RequireSection>} />
        <Route path="masking" element={<RequireSection path="masking"><MaskingSection /></RequireSection>} />
        <Route path="connections" element={<RequireSection path="connections"><ConnectionsSection /></RequireSection>} />
        <Route path="journal" element={<RequireSection path="journal"><JournalSection /></RequireSection>} />
        <Route path="interface" element={<RequireSection path="interface"><InterfaceSection /></RequireSection>} />
        <Route path="storage" element={<RequireSection path="storage"><StorageSection /></RequireSection>} />
      </Route>
    </Routes>
  );
}
