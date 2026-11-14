-- Projects of conversations (spec, section 8.12): a person's own folders with instructions and
-- files. The link "conversation → project" lives here, not in Mastra's thread metadata: a project
-- can be chosen before the first message, when Mastra has no thread yet.
CREATE TABLE app.projects (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES app."user" ("id") ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  instructions text NOT NULL DEFAULT '' CHECK (length(instructions) <= 8000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX projects_user_name_idx ON app.projects (user_id, lower(name));

CREATE TABLE app.thread_projects (
  thread_id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES app."user" ("id") ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES app.projects (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX thread_projects_project_idx ON app.thread_projects (project_id);
CREATE INDEX thread_projects_user_idx ON app.thread_projects (user_id);
