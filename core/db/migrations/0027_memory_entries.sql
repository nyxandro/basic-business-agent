-- Memory of a project and of an employee (spec, section 8.26): short facts the agents and people keep between
-- conversations. An entry belongs to a project (seen by everyone who sees the project) or to one employee
-- (their personal memory). `number` is what the agent names an entry by; numbers are never given again —
-- each memory has its counter, whose row is also the lock of that memory while it changes.
-- `author_id`, `by_agent` — who changed the entry last, a person by hand or a person's agent.
CREATE TABLE app.memory_entries (
  id uuid PRIMARY KEY,
  project_id uuid REFERENCES app.projects (id) ON DELETE CASCADE,
  user_id text REFERENCES app."user" ("id") ON DELETE CASCADE,
  number integer NOT NULL CHECK (number > 0),
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 400),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  author_id text REFERENCES app."user" ("id") ON DELETE SET NULL,
  by_agent boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((project_id IS NULL) <> (user_id IS NULL))
);
CREATE UNIQUE INDEX memory_entries_project_number_idx ON app.memory_entries (project_id, number) WHERE project_id IS NOT NULL;
CREATE UNIQUE INDEX memory_entries_user_number_idx ON app.memory_entries (user_id, number) WHERE user_id IS NOT NULL;
CREATE INDEX memory_entries_author_idx ON app.memory_entries (author_id);

CREATE TABLE app.memory_counters (
  project_id uuid REFERENCES app.projects (id) ON DELETE CASCADE,
  user_id text REFERENCES app."user" ("id") ON DELETE CASCADE,
  last_number integer NOT NULL DEFAULT 0,
  CHECK ((project_id IS NULL) <> (user_id IS NULL))
);
CREATE UNIQUE INDEX memory_counters_project_idx ON app.memory_counters (project_id) WHERE project_id IS NOT NULL;
CREATE UNIQUE INDEX memory_counters_user_idx ON app.memory_counters (user_id) WHERE user_id IS NOT NULL;
