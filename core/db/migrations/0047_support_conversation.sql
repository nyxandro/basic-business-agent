-- A ticket is a conversation (docs/specs/[20.11.2026]-feedback-and-value.md, F9; owner 24.11): the employee and the support
-- write as many messages as they need, with files; who wrote last sets the state; a ticket closed — «Проблема решена» of
-- the employee, or the support's «Решено» / «Отклонено» — takes no more messages from either side.

CREATE TABLE app.support_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id bigint NOT NULL REFERENCES app.support_tickets (id) ON DELETE CASCADE,
  side text NOT NULL CHECK (side IN ('employee', 'support')),
  -- Null — the person was removed.
  author_id text REFERENCES app."user" ("id") ON DELETE SET NULL,
  -- Up to 4000 by the routes; 8000 for a comment of a complaint written before, with what was added to it.
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 8000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_messages_ticket_idx ON app.support_messages (ticket_id, id);

-- The comment of every ticket is its first message; an answer of the support, its second.
INSERT INTO app.support_messages (ticket_id, side, author_id, text, created_at)
  SELECT id, 'employee', user_id, comment, created_at FROM app.support_tickets ORDER BY id;
INSERT INTO app.support_messages (ticket_id, side, author_id, text, created_at)
  SELECT id, 'support', handled_by, reply, updated_at FROM app.support_tickets WHERE reply IS NOT NULL ORDER BY id;

-- A file attached to a message; null — a file of the conversation copied with a complaint, for the support's eyes.
ALTER TABLE app.support_files ADD COLUMN message_id bigint REFERENCES app.support_messages (id) ON DELETE CASCADE;
CREATE INDEX support_files_message_idx ON app.support_files (message_id) WHERE message_id IS NOT NULL;
UPDATE app.support_files f SET message_id = m.id
  FROM app.support_messages m JOIN app.support_tickets t ON t.id = m.ticket_id
 WHERE f.ticket_id = t.id AND t.kind = 'request' AND m.side = 'employee' AND f.path IS NULL;
ALTER TABLE app.support_files ADD CONSTRAINT support_files_message_or_path CHECK ((message_id IS NULL) = (path IS NOT NULL));

-- The states: waiting for the support (open), answered by it (answered), closed (resolved, rejected) — and who closed.
ALTER TABLE app.support_tickets ADD COLUMN closed_side text CHECK (closed_side IN ('employee', 'support'));
ALTER TABLE app.support_tickets ADD COLUMN closed_at timestamptz;
ALTER TABLE app.support_tickets DROP CONSTRAINT support_tickets_status_check;
UPDATE app.support_tickets SET status = CASE WHEN reply IS NULL THEN 'open' ELSE 'answered' END WHERE status IN ('new', 'in_progress');
UPDATE app.support_tickets SET closed_side = 'support', closed_at = updated_at WHERE status IN ('resolved', 'rejected');
ALTER TABLE app.support_tickets ADD CONSTRAINT support_tickets_status_check CHECK (status IN ('open', 'answered', 'resolved', 'rejected'));
ALTER TABLE app.support_tickets ADD CONSTRAINT support_tickets_closed CHECK ((status IN ('resolved', 'rejected')) = (closed_side IS NOT NULL AND closed_at IS NOT NULL));

-- The comment, the one answer and who gave it live in the messages now.
ALTER TABLE app.support_tickets DROP COLUMN comment, DROP COLUMN reply, DROP COLUMN handled_by;
