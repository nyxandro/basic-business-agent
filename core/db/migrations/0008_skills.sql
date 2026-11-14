-- Skills uploaded in the admin panel (spec, section 8.15): the archive itself lives here, so a
-- backup of the database keeps the skills; the server unpacks it into APP_SKILLS_DIR.
CREATE TABLE app.skills (
  name text PRIMARY KEY CHECK (name ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  title text NOT NULL,
  description text NOT NULL,
  archive bytea NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes integer NOT NULL CHECK (size_bytes > 0),
  -- Paths and sizes of the files, shown in the admin panel.
  files jsonb NOT NULL,
  has_scripts boolean NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  scope text NOT NULL CHECK (scope IN ('org', 'departments', 'users')),
  uploaded_by text REFERENCES app."user" ("id") ON DELETE SET NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

-- Who gets a skill when its scope is departments or employees: exactly one of the two per row.
CREATE TABLE app.skill_scope (
  skill_name text NOT NULL REFERENCES app.skills (name) ON DELETE CASCADE,
  department_id uuid REFERENCES app.departments (id) ON DELETE CASCADE,
  user_id text REFERENCES app."user" ("id") ON DELETE CASCADE,
  CONSTRAINT skill_scope_one_target CHECK (num_nonnulls(department_id, user_id) = 1)
);
CREATE UNIQUE INDEX skill_scope_department_idx ON app.skill_scope (skill_name, department_id) WHERE department_id IS NOT NULL;
CREATE UNIQUE INDEX skill_scope_user_idx ON app.skill_scope (skill_name, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX skill_scope_by_department_idx ON app.skill_scope (department_id);
CREATE INDEX skill_scope_by_user_idx ON app.skill_scope (user_id);
