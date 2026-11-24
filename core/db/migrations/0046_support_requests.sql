-- A request written to the support straight from «Мои обращения» (docs/specs/[20.11.2026]-feedback-and-value.md, F7; owner
-- 24.11): a subject, a text and the files the employee attached — no agent, conversation, turn, copy of it or models.
-- Every ticket before it is a complaint about an answer.
ALTER TABLE app.support_tickets ADD COLUMN kind text NOT NULL DEFAULT 'complaint' CHECK (kind IN ('complaint', 'request'));
ALTER TABLE app.support_tickets ALTER COLUMN kind DROP DEFAULT;
ALTER TABLE app.support_tickets ADD COLUMN subject text CHECK (length(subject) BETWEEN 1 AND 200);
ALTER TABLE app.support_tickets ALTER COLUMN agent_id DROP NOT NULL, ALTER COLUMN thread_id DROP NOT NULL, ALTER COLUMN turn_key DROP NOT NULL;
ALTER TABLE app.support_tickets ADD CONSTRAINT support_tickets_kind_fields CHECK (
  CASE kind
    WHEN 'complaint' THEN agent_id IS NOT NULL AND thread_id IS NOT NULL AND turn_key IS NOT NULL AND subject IS NULL
    ELSE agent_id IS NULL AND thread_id IS NULL AND turn_key IS NULL AND task_id IS NULL AND subject IS NOT NULL
      AND snapshot = '[]'::jsonb AND cardinality(models) = 0 AND instructions_at IS NULL
  END
);
-- A file the employee attached has no place in a folder of a conversation.
ALTER TABLE app.support_files ALTER COLUMN path DROP NOT NULL;
