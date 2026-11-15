-- Shared projects and the archive (spec, section 8.20; decisions of the owner 16.11.2026). The
-- creator opens a project to departments and people or to the whole organisation; a project is not
-- removed but archived. Each person keeps their own place of a project in the side panel, so the
-- order and pinning move out of the project itself. Projects made earlier stay private.
ALTER TABLE app.projects
  ADD COLUMN access text CHECK (access IN ('private', 'list', 'org')),
  ADD COLUMN archived_at timestamptz;
UPDATE app.projects SET access = 'private';
ALTER TABLE app.projects ALTER COLUMN access SET NOT NULL;

-- Who a project «Выбранным» is open to: one department or one person per row, as app.task_scope.
CREATE TABLE app.project_shares (
  project_id uuid NOT NULL REFERENCES app.projects (id) ON DELETE CASCADE,
  department_id uuid REFERENCES app.departments (id) ON DELETE CASCADE,
  user_id text REFERENCES app."user" ("id") ON DELETE CASCADE,
  CONSTRAINT project_shares_one_target CHECK (num_nonnulls(department_id, user_id) = 1)
);
CREATE UNIQUE INDEX project_shares_department_idx ON app.project_shares (project_id, department_id) WHERE department_id IS NOT NULL;
CREATE UNIQUE INDEX project_shares_user_idx ON app.project_shares (project_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX project_shares_project_idx ON app.project_shares (project_id);
CREATE INDEX project_shares_by_department_idx ON app.project_shares (department_id);
CREATE INDEX project_shares_by_user_idx ON app.project_shares (user_id);

-- A project's place in one person's side panel. A colleague has no row until they open the project,
-- pin it or drag the list; `seen_at` empty is «новое».
CREATE TABLE app.project_places (
  user_id text NOT NULL REFERENCES app."user" ("id") ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES app.projects (id) ON DELETE CASCADE,
  position integer NOT NULL,
  pinned boolean NOT NULL,
  seen_at timestamptz,
  PRIMARY KEY (user_id, project_id)
);
CREATE INDEX project_places_project_idx ON app.project_places (project_id);
INSERT INTO app.project_places (user_id, project_id, position, pinned, seen_at)
SELECT user_id, id, position, pinned, now() FROM app.projects;
ALTER TABLE app.projects DROP COLUMN position, DROP COLUMN pinned;

-- A colleague's conversation keeps the name of a project removed for good, to say so above the input;
-- a closed or archived project keeps its link, so the conversation comes back when it is reopened.
ALTER TABLE app.thread_projects
  ALTER COLUMN project_id DROP NOT NULL,
  ADD COLUMN lost_project_name text,
  DROP CONSTRAINT thread_projects_project_id_fkey,
  ADD CONSTRAINT thread_projects_project_id_fkey FOREIGN KEY (project_id) REFERENCES app.projects (id) ON DELETE SET NULL;
