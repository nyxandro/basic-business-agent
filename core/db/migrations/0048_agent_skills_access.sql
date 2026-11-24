-- Skills belong to agents; a person gets an agent — and its skills — through the access of the agent (owner's decision
-- 24.11, spec section 8.15): the whole organisation, departments (app.department_agents, also «Агенты отдела») or employees
-- by name. Agents live in the files of the installation, so agent_id has no foreign key, as in app.department_agents.

-- An agent open to the whole organisation.
CREATE TABLE app.agent_org_access (
  agent_id text PRIMARY KEY
);

-- An agent open to an employee by name.
CREATE TABLE app.agent_people (
  agent_id text NOT NULL,
  user_id text NOT NULL REFERENCES app."user" ("id") ON DELETE CASCADE,
  PRIMARY KEY (agent_id, user_id)
);
CREATE INDEX agent_people_user_idx ON app.agent_people (user_id);

-- The uploaded skills of an agent: one link, set from the skill or from the agent.
CREATE TABLE app.agent_skills (
  agent_id text NOT NULL,
  skill_name text NOT NULL REFERENCES app.skills (name) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, skill_name)
);
CREATE INDEX agent_skills_skill_idx ON app.agent_skills (skill_name);

-- A skill has no scope of people any more. Skills uploaded before stay with no agent until the admin ticks the agents
-- (there are no live installations to carry over).
DROP TABLE app.skill_scope;
ALTER TABLE app.skills DROP COLUMN scope;
