-- Complaints, samples and the report of value (docs/specs/[20.11.2026]-feedback-and-value.md).

-- A complaint about an answer (owner 21.11, F1): the employee's comment and a copy of the conversation as it was — its
-- visible messages and the steps of the agent — which does not depend on what is done with the conversation later.
-- Read by the people with «Агенты» (F5). The author removed — «бывший сотрудник».
CREATE TABLE app.support_tickets (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text REFERENCES app."user" ("id") ON DELETE SET NULL,
  agent_id text NOT NULL,
  thread_id text NOT NULL,
  -- The turn complained about: the number of the person's message it answered, among the person's messages of the
  -- conversation (the ids of answers differ between the live stream and a reload).
  turn_key integer NOT NULL CHECK (turn_key >= 1),
  task_id text,
  comment text NOT NULL CHECK (length(comment) BETWEEN 1 AND 8000),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'array'),
  models text[] NOT NULL,
  -- When the agent's instructions in use were published; null — the instructions of the agent's file.
  instructions_at timestamptz,
  status text NOT NULL CHECK (status IN ('new', 'in_progress', 'resolved', 'rejected')),
  reply text CHECK (length(reply) <= 8000),
  handled_by text REFERENCES app."user" ("id") ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- One complaint per turn: a second one adds to the first (scenario 1).
CREATE UNIQUE INDEX support_tickets_turn_idx ON app.support_tickets (user_id, thread_id, turn_key) WHERE user_id IS NOT NULL;
CREATE INDEX support_tickets_status_idx ON app.support_tickets (status, created_at DESC);

-- The files of the conversation, copied when the complaint was made: up to 50 MB a complaint; the rest is named with its
-- size. Kept in the database, as the files of the knowledge base: the ticket outlives the conversation and its folder.
CREATE TABLE app.support_files (
  ticket_id bigint NOT NULL REFERENCES app.support_tickets (id) ON DELETE CASCADE,
  ord integer NOT NULL,
  name text NOT NULL,
  path text NOT NULL,
  size bigint,
  state text NOT NULL CHECK (state IN ('copied', 'too_large', 'gone')),
  content bytea,
  PRIMARY KEY (ticket_id, ord),
  CHECK ((state = 'copied') = (content IS NOT NULL))
);

-- A sample (F4): a document the agent made, marked «Хороший образец», goes into the knowledge base as `kind = 'example'`.
ALTER TABLE app.kb_documents ADD COLUMN doc_type text CHECK (length(doc_type) BETWEEN 1 AND 100);
ALTER TABLE app.kb_documents ADD CONSTRAINT kb_documents_example_type CHECK (kind <> 'example' OR doc_type IS NOT NULL);

-- Which file of which conversation was marked: «Уже сохранён как образец», and «Был образцом» once the keeper of the base
-- removed it.
CREATE TABLE app.example_marks (
  user_id text NOT NULL REFERENCES app."user" ("id") ON DELETE CASCADE,
  thread_id text NOT NULL,
  path text NOT NULL,
  sha256 text NOT NULL,
  document_id uuid REFERENCES app.kb_documents (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, thread_id, path, sha256)
);
CREATE INDEX example_marks_document_idx ON app.example_marks (document_id) WHERE document_id IS NOT NULL;

-- The facts of work, written when the work is done (section 8): the report counts them, never the stored messages —
-- removing a conversation or a person does not change past months. The person's id only counts «работали с агентами»;
-- the departments are the person's at the time.
CREATE TABLE app.work_facts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('document', 'action', 'email', 'background_run', 'web_research', 'knowledge_answer', 'conversation', 'message')),
  at timestamptz NOT NULL DEFAULT now(),
  user_id text,
  agent_id text,
  department_ids uuid[] NOT NULL
);
CREATE INDEX work_facts_at_idx ON app.work_facts (at);

-- The norms of the report (F2): minutes of work a fact of a kind stands for. The admin changes them; changes are audited.
CREATE TABLE app.value_norms (
  kind text PRIMARY KEY CHECK (kind IN ('document', 'action', 'email', 'background_run', 'web_research', 'knowledge_answer')),
  minutes integer NOT NULL CHECK (minutes BETWEEN 0 AND 600)
);
INSERT INTO app.value_norms (kind, minutes) VALUES
  ('document', 20), ('action', 3), ('email', 5), ('background_run', 5), ('web_research', 10), ('knowledge_answer', 5);

-- One row: since when the facts are written (the report says so for earlier months) and the cost of an hour, if set.
CREATE TABLE app.value_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  facts_since timestamptz NOT NULL DEFAULT now(),
  hour_rub numeric(10, 2) CHECK (hour_rub > 0)
);
INSERT INTO app.value_settings (id) VALUES (true);
