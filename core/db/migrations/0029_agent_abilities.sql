-- What each agent may do (spec, section 8.30; decisions of the owner 19.11): the internet (search and pages,
-- through the researcher) and the commands of the sandbox. The agents live in the files of the installation,
-- so the server writes a row for every agent of the registry that has none at each start, with the core's
-- defaults of that moment: a later change of the defaults never switches an agent the admin left as it was.
-- A row of an agent removed from the installation stays, like its prompt override and its mark.
CREATE TABLE app.agent_abilities (
  agent_id text PRIMARY KEY,
  web boolean NOT NULL,
  commands boolean NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
