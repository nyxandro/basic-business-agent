-- Prompt edits over the agent's file (spec, section 8.3): who keeps a draft, what is published,
-- and the file hash at publication to show "the file changed after the admin's edit".
ALTER TABLE app.agent_overrides ALTER COLUMN file_instructions_hash DROP NOT NULL;
ALTER TABLE app.agent_overrides
  ADD COLUMN draft_version_id text,
  ADD COLUMN draft_by text REFERENCES app."user" ("id") ON DELETE SET NULL,
  ADD COLUMN draft_at timestamptz,
  ADD COLUMN published_version_id text,
  ADD COLUMN model_id text;
