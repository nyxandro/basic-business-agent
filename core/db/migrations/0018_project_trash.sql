-- The trash of a project (spec, section 8.20; decision of the owner 16.11.2026): a file removed by a
-- button of the page or by the agent in any way, or the previous version of a file the agent
-- replaced, lies here 30 days; the file itself is projects/<id>/trash/<trash id> next to its files.
-- One removal by a person, or everything one answer of the agent removed, is one batch.
CREATE TABLE app.project_trash (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES app.projects (id) ON DELETE CASCADE,
  path text NOT NULL CHECK (length(path) > 0),
  bytes bigint NOT NULL CHECK (bytes >= 0),
  kind text NOT NULL CHECK (kind IN ('deleted', 'previous_version')),
  via text NOT NULL CHECK (via IN ('page', 'agent')),
  deleted_by text REFERENCES app."user" ("id") ON DELETE SET NULL,
  thread_id text,
  batch_id uuid NOT NULL,
  deleted_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > deleted_at)
);
CREATE INDEX project_trash_project_idx ON app.project_trash (project_id, deleted_at DESC);
CREATE INDEX project_trash_expires_idx ON app.project_trash (expires_at);
CREATE INDEX project_trash_deleted_by_idx ON app.project_trash (deleted_by);
