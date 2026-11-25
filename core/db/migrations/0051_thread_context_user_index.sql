-- How full a conversation is (spec, section 8.34): the removal of an employee takes their rows of app.thread_context
-- by the foreign key — found by this index, not by reading the whole table.
CREATE INDEX thread_context_user_idx ON app.thread_context (user_id);
