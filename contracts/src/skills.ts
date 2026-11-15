import { z } from 'zod';

// «Скиллы» (spec, scenario 10, section 8.15): uploaded `.skill` files and who gets them.
export const SKILL_SCOPES = ['org', 'departments', 'users'] as const;
export type SkillScope = (typeof SKILL_SCOPES)[number];

// «Вся организация», «Отделы» or «Сотрудники»; the lists matter for the last two only.
export const skillAccessSchema = z.object({
  scope: z.enum(SKILL_SCOPES),
  departmentIds: z.array(z.uuid()),
  userIds: z.array(z.string().min(1)),
});
export type SkillAccess = z.infer<typeof skillAccessSchema>;

export const skillUpdateSchema = z.object({ enabled: z.boolean().optional(), access: skillAccessSchema.optional() });
export type SkillUpdate = z.infer<typeof skillUpdateSchema>;

export interface SkillFile {
  path: string;
  bytes: number;
}

// What the admin sees before saving an uploaded file.
export interface SkillPreview {
  name: string;
  title: string;
  description: string;
  sizeBytes: number;
  files: SkillFile[];
  hasScripts: boolean;
  // A skill with this name is already uploaded: saving is «Заменить».
  exists: boolean;
}

export interface SkillDto extends Omit<SkillPreview, 'exists'> {
  enabled: boolean;
  access: SkillAccess;
  // A system skill of the core (spec, section 8.18): always on for the whole organisation, cannot be
  // switched off, replaced or removed; it was never uploaded (uploadedAt is null).
  system: boolean;
  uploadedAt: string | null;
  uploadedBy: string | null;
}

// What the scripts of skills may use in the sandbox (no network there to install anything).
export interface SkillsSandbox {
  programs: string[];
  python: string[];
  node: string[];
}

export interface SkillsResponse {
  // System skills of the core first (section 8.18), then the uploaded ones.
  skills: SkillDto[];
  sandbox: SkillsSandbox;
}
