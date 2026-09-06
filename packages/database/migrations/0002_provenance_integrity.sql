-- 0002_provenance_integrity
--
-- Codex audit correction (Sprint 2). Migration 0001 linked the ingestion
-- tables with independent single-column foreign keys, which let a row's
-- provenance contradict its batch: a source row with a different origin from
-- its batch, an issue naming one batch while its row belongs to another, a
-- snapshot whose label or origin differs from its batch, a review entry
-- joining one batch's snapshot to another batch's row, or a row whose
-- canonical URL disagrees with its URL group. Provenance gaps must be
-- explicit (docs/SECURITY.md section 7), so this migration makes every such
-- contradiction impossible relationally, with composite unique keys and
-- composite foreign keys.
--
-- Forward-only. Migration 0001 is not altered. Every constraint below
-- validates existing rows when it is added, so a database that already holds
-- a contradiction fails this migration and is left unchanged; nothing is
-- rewritten silently. The only data change is the deterministic backfill of
-- review_entries.batch_id from each entry's snapshot, a column that did not
-- exist before.
--
-- Also adds safety limits on the two metadata fields that are printed:
-- review labels and source basenames may not carry control characters
-- (C0, DEL, C1) or the Unicode line and paragraph separators, and have fixed
-- maximum lengths. Raw editorial fields are untouched.

-- Parent keys that carry provenance alongside the id.
ALTER TABLE import_batches
  ADD CONSTRAINT import_batches_id_origin UNIQUE (id, data_origin),
  ADD CONSTRAINT import_batches_id_label_origin UNIQUE (id, review_label, data_origin),
  ADD CONSTRAINT import_batches_basename_safe CHECK (
    length(source_basename) <= 255
    AND source_basename !~ '[\x01-\x1F\x7F-\x9F\u2028\u2029]'
  ),
  ADD CONSTRAINT import_batches_label_safe CHECK (
    review_label IS NULL
    OR (
      length(review_label) <= 64
      AND review_label = btrim(review_label)
      AND review_label !~ '[\x01-\x1F\x7F-\x9F\u2028\u2029]'
    )
  );

ALTER TABLE url_groups
  ADD CONSTRAINT url_groups_id_canonical UNIQUE (id, canonical_url);

-- A source row's origin must be its batch's origin, and its canonical URL
-- must be the canonical URL of the group it references.
ALTER TABLE source_rows
  ADD CONSTRAINT source_rows_id_batch UNIQUE (id, batch_id),
  ADD CONSTRAINT source_rows_batch_origin_fk
    FOREIGN KEY (batch_id, data_origin) REFERENCES import_batches (id, data_origin),
  ADD CONSTRAINT source_rows_url_group_fk
    FOREIGN KEY (url_group_id, canonical_url) REFERENCES url_groups (id, canonical_url);

-- An issue's batch must be the batch of the row it describes.
ALTER TABLE row_issues
  ADD CONSTRAINT row_issues_row_batch_fk
    FOREIGN KEY (source_row_id, batch_id) REFERENCES source_rows (id, batch_id);

-- A snapshot's label and origin must be its batch's label and origin.
ALTER TABLE review_snapshots
  ADD CONSTRAINT review_snapshots_id_batch UNIQUE (id, batch_id),
  ADD CONSTRAINT review_snapshots_batch_label_origin_fk
    FOREIGN KEY (batch_id, review_label, data_origin)
    REFERENCES import_batches (id, review_label, data_origin),
  ADD CONSTRAINT review_snapshots_label_safe CHECK (
    length(review_label) <= 64
    AND review_label = btrim(review_label)
    AND review_label !~ '[\x01-\x1F\x7F-\x9F\u2028\u2029]'
  );

-- A review entry names its batch explicitly; the batch must own both the
-- snapshot and the source row. Backfilled deterministically from the
-- entry's snapshot, then required.
ALTER TABLE review_entries
  ADD COLUMN batch_id uuid;

UPDATE review_entries AS e
   SET batch_id = s.batch_id
  FROM review_snapshots AS s
 WHERE s.id = e.snapshot_id;

ALTER TABLE review_entries
  ALTER COLUMN batch_id SET NOT NULL,
  ADD CONSTRAINT review_entries_snapshot_batch_fk
    FOREIGN KEY (snapshot_id, batch_id) REFERENCES review_snapshots (id, batch_id),
  ADD CONSTRAINT review_entries_row_batch_fk
    FOREIGN KEY (source_row_id, batch_id) REFERENCES source_rows (id, batch_id);

CREATE INDEX review_entries_batch_idx ON review_entries (batch_id);
