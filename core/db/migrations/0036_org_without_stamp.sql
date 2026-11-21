-- An organisation that works without a stamp (decision of the owner 21.11: «галочку в настройках админки … режим без
-- печати»): the agents of the responsible people put the signature of the director alone. A stamp uploaded before stays
-- kept and comes back when the switch goes off.
ALTER TABLE app.org_profile ADD COLUMN without_stamp boolean NOT NULL DEFAULT false;
