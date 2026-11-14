import { z } from 'zod';

// Rights a role can grant (spec, section 8.2): sections of the admin panel and, reserved for the
// knowledge base specification, rights on documents. Nobody gets a right to read others' chats.
export const ADMIN_SECTIONS = [
  'users',
  'roles',
  'departments',
  'limits',
  'usage',
  'agents',
  'org_profile',
  'masking',
  'connections',
  'journal',
  'models',
  'skills',
] as const;
export const DOCUMENT_PERMISSIONS = ['documents.org.manage', 'documents.department.manage'] as const;
export const PERMISSIONS = [...ADMIN_SECTIONS, ...DOCUMENT_PERMISSIONS] as const;
export type Permission = (typeof PERMISSIONS)[number];
export type AdminSection = (typeof ADMIN_SECTIONS)[number];

export const MIN_PASSWORD_LENGTH = 10;

export const passwordBodySchema = z.object({ password: z.string().min(MIN_PASSWORD_LENGTH) });

export const inviteCreateSchema = z.object({
  email: z.email(),
  name: z.string().trim().min(1),
  roleIds: z.array(z.uuid()).min(1),
  departmentIds: z.array(z.uuid()),
});
export type InviteCreate = z.infer<typeof inviteCreateSchema>;

export const passwordResetCreateSchema = z.object({ userId: z.string().min(1) });

export const userRolesSchema = z.object({ roleIds: z.array(z.uuid()).min(1) });

export const roleBodySchema = z.object({
  name: z.string().trim().min(1),
  permissions: z.array(z.enum(PERMISSIONS)),
});

export const departmentBodySchema = z.object({ name: z.string().trim().min(1) });
export const departmentMembersSchema = z.object({ userIds: z.array(z.string().min(1)) });
export const departmentAgentsSchema = z.object({ agentIds: z.array(z.string().min(1)) });

export interface MeResponse {
  user: { id: string; email: string; name: string };
  permissions: Permission[];
  isSuperadmin: boolean;
  departmentIds: string[];
  // A recognition model is chosen and enabled in «Нейросеть»: the chat shows the microphone.
  voiceAvailable: boolean;
  organisation: { name: string };
}
