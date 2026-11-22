-- Fixes of the knowledge base after its independent review (docs/specs/[20.11.2026]-knowledge-base.md, section 15):
-- a version that keeps failing or finding the server busy is refused after a few tries instead of holding the queue,
-- and the dictionary of typos may pass through zero while two documents with a common word are removed at once.
ALTER TABLE app.kb_versions ADD COLUMN attempts integer NOT NULL DEFAULT 0;
ALTER TABLE app.kb_words DROP CONSTRAINT kb_words_count_check;
ALTER TABLE app.kb_words ADD CONSTRAINT kb_words_count_check CHECK (count >= 0);
