-- Typos counted in edits (spec, section 8.21): pg_trgm picks candidates through the index, and
-- levenshtein of fuzzystrmatch keeps those within one edit for a word of 4–7 letters, two for longer.
-- Trigram likeness alone misses most single typos in short Russian words (measured 16.11: 41 of 224
-- at its usual threshold, and at a threshold that finds them — also pairs like «счёт» and «отчёт»).
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;
