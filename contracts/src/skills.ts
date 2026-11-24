import { z } from 'zod';

// «Скиллы» (spec, scenario 10, section 8.15): uploaded `.skill` files and the agents that have them. A skill has no access of
// its own (owner's decision 24.11): a person gets it through an agent open to them; a new skill is with no agent.
export const skillAgentsSchema = z.array(z.string().min(1));

export const skillUpdateSchema = z.object({ enabled: z.boolean().optional(), agentIds: skillAgentsSchema.optional() });
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
  // The agents that have the skill, also those an installation no longer has (the list shows only its agents). Empty for a
  // system skill: it is with every agent that may run commands.
  agentIds: string[];
  // A system skill of the core (spec, section 8.18): always on for every agent, cannot be switched off, given to agents,
  // replaced or removed; it was never uploaded (uploadedAt is null).
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
