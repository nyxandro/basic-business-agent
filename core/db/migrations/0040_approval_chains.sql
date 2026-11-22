-- Multi-step approvals (docs/specs/[20.11.2026]-multi-step-approvals.md): after the employee's «Да» an action under a
-- rule becomes a request that runs once every stage of approvers agreed.

-- The heads of a department (owner 21.11, F1): «руководитель отдела сотрудника» approves at a stage.
CREATE TABLE app.department_heads (
  department_id uuid NOT NULL REFERENCES app.departments (id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES app."user" ("id") ON DELETE CASCADE,
  PRIMARY KEY (department_id, user_id)
);

-- A rule: an action of agents (its name as agents call it) and the stages of approvers, in order. A stage is a list of
-- approvers, any of whom decides: { "kind": "head" } — the heads of the employee's departments, { "kind": "user", "userId" }.
CREATE TABLE app.approval_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target text NOT NULL,
  stages jsonb NOT NULL CHECK (jsonb_typeof(stages) = 'array' AND jsonb_array_length(stages) BETWEEN 1 AND 5),
  enabled boolean NOT NULL,
  created_by text REFERENCES app."user" ("id") ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approval_rules_target_idx ON app.approval_rules (target) WHERE enabled;

-- «Зачем — увидят согласующие»: written by the card of «Да» before the answer, read when the request is made.
CREATE TABLE app.approval_chain_reasons (
  tool_call_id text NOT NULL,
  user_id text NOT NULL REFERENCES app."user" ("id") ON DELETE CASCADE,
  comment text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tool_call_id)
);

-- A request: the action with its full parameters (encrypted), the stages as they were when it was made, where it stands.
CREATE TABLE app.approval_chains (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL REFERENCES app."user" ("id") ON DELETE CASCADE,
  agent_id text NOT NULL,
  thread_id text NOT NULL,
  project_id text,
  run_kind text NOT NULL CHECK (run_kind IN ('chat', 'background')),
  task_id text,
  target text NOT NULL,
  args_ciphertext bytea NOT NULL,
  args_iv bytea NOT NULL,
  args_key_version integer NOT NULL,
  args_hash text NOT NULL,
  summary text NOT NULL,
  labels jsonb NOT NULL,
  comment text NOT NULL,
  -- The approvers of each stage as resolved when the request was made: [[userId, ...], ...]; an empty stage is passed.
  stages jsonb NOT NULL,
  stage_names jsonb NOT NULL,
  stage integer NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'executing', 'done', 'failed', 'declined', 'expired', 'withdrawn', 'unknown_outcome')),
  call_started_at timestamptz,
  result jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  stage_expires_at timestamptz NOT NULL,
  retry_until timestamptz,
  finished_at timestamptz
);
-- One waiting request per employee, action and parameters: the agent asking again gets «уже на согласовании».
CREATE UNIQUE INDEX approval_chains_one_waiting ON app.approval_chains (user_id, target, args_hash) WHERE status IN ('pending', 'executing');
CREATE INDEX approval_chains_user_idx ON app.approval_chains (user_id, created_at DESC);
CREATE INDEX approval_chains_waiting_idx ON app.approval_chains (stage_expires_at) WHERE status = 'pending';

-- Every decision of a stage, and a stage passed because the employee is its approver (owner 21.11, F4).
CREATE TABLE app.approval_chain_decisions (
  chain_id bigint NOT NULL REFERENCES app.approval_chains (id) ON DELETE CASCADE,
  stage integer NOT NULL,
  user_id text REFERENCES app."user" ("id") ON DELETE SET NULL,
  decision text NOT NULL CHECK (decision IN ('approved', 'declined', 'self')),
  reason text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approval_chain_decisions_chain_idx ON app.approval_chain_decisions (chain_id, stage);
