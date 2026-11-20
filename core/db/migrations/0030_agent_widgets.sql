-- «Виджеты в чате» (spec, section 8.31; decision of the owner 20.11, F41): the third switch of «Что агенту можно».
-- On by default, for the agents of the installation too: the owner wants every agent to draw widgets until the
-- admin switches them off. The column keeps no default after that: rows of new agents are written by the server
-- with the core's defaults (core/abilities/abilities.ts), as for the other switches.
ALTER TABLE app.agent_abilities ADD COLUMN widgets boolean NOT NULL DEFAULT true;
ALTER TABLE app.agent_abilities ALTER COLUMN widgets DROP DEFAULT;
