-- The project an answer waiting for «Да» was started in (spec, section 8.20). After «Да» Mastra goes
-- on with that same answer — its prompt still holds the project — so the answer is finished in that
-- project, even when access to it was closed meanwhile; the next answer asks anew.
ALTER TABLE app.approval_requests ADD COLUMN project_id uuid REFERENCES app.projects (id) ON DELETE SET NULL;
CREATE INDEX approval_requests_project_idx ON app.approval_requests (project_id);
