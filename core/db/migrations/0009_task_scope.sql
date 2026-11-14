-- Background tasks with a scope (spec, scenario 4, section 8.6): the admin sets a task for the
-- organisation, departments or employees; each fire becomes one run per employee, on that
-- employee's access and limits, in the conversation "bg:<taskId>:<userId>".
ALTER TABLE app.background_tasks
  ADD COLUMN scope text CHECK (scope IN ('org', 'departments', 'users')),
  ADD COLUMN created_by text REFERENCES app."user" ("id") ON DELETE SET NULL;

CREATE TABLE app.task_scope (
  task_id text NOT NULL REFERENCES app.background_tasks (id) ON DELETE CASCADE,
  department_id uuid REFERENCES app.departments (id) ON DELETE CASCADE,
  user_id text REFERENCES app."user" ("id") ON DELETE CASCADE,
  CONSTRAINT task_scope_one_target CHECK (num_nonnulls(department_id, user_id) = 1)
);
CREATE UNIQUE INDEX task_scope_department_idx ON app.task_scope (task_id, department_id) WHERE department_id IS NOT NULL;
CREATE UNIQUE INDEX task_scope_user_idx ON app.task_scope (task_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX task_scope_by_department_idx ON app.task_scope (department_id);
CREATE INDEX task_scope_by_user_idx ON app.task_scope (user_id);

-- A stage 1 task belonged to its owner: the owner becomes its one employee and its author.
UPDATE app.background_tasks SET scope = 'users', created_by = owner_user_id;
INSERT INTO app.task_scope (task_id, user_id) SELECT id, owner_user_id FROM app.background_tasks WHERE owner_user_id IS NOT NULL;
UPDATE app.background_tasks SET status = 'paused', paused_reason = 'scope_empty' WHERE owner_user_id IS NULL;
ALTER TABLE app.background_tasks ALTER COLUMN scope SET NOT NULL;
ALTER TABLE app.background_tasks DROP COLUMN owner_user_id, DROP COLUMN thread_id, DROP COLUMN unread_result;

CREATE TABLE app.background_task_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id text NOT NULL REFERENCES app.background_tasks (id) ON DELETE CASCADE,
  -- The time the schedule named: the same fire never makes a second run of one employee.
  fire_at timestamptz NOT NULL,
  user_id text NOT NULL REFERENCES app."user" ("id") ON DELETE CASCADE,
  outcome text NOT NULL CHECK (outcome IN ('queued', 'running', 'done', 'awaiting-approval', 'failed', 'skipped')),
  reason_code text,
  started_at timestamptz,
  finished_at timestamptz,
  -- The result is «новое» until the employee opens the conversation.
  unread boolean NOT NULL DEFAULT false,
  CONSTRAINT background_task_runs_once UNIQUE (task_id, fire_at, user_id)
);
CREATE INDEX background_task_runs_user_idx ON app.background_task_runs (user_id);
CREATE INDEX background_task_runs_queue_idx ON app.background_task_runs (fire_at, id) WHERE outcome = 'queued';
