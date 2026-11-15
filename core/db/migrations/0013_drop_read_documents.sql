-- «Чтение документов» gives way to the system skills of documents of the core (spec, section 8.18;
-- decision of the owner 15.11.2026): an uploaded copy would give the agent a second, older way to
-- read the same files. Who gets it (skill_scope) goes with it; the unpacked copy goes at the next
-- start of the server. The audit keeps a record, as for a removal in the admin panel.
INSERT INTO app.admin_audit (actor_user_id, action, target, details)
SELECT NULL, 'skill.delete', name, jsonb_build_object('sha256', sha256, 'reason', 'replaced by the system skills of documents (migration 0013)')
  FROM app.skills
 WHERE name = 'read-documents';

DELETE FROM app.skills WHERE name = 'read-documents';
