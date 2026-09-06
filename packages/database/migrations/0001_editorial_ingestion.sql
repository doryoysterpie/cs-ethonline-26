-- 0001_editorial_ingestion
--
-- Editorial ingestion foundation (Sprint 2, decision D20). Forward-only; no
-- down migration exists. Raw source data, provenance, derived fields and human
-- review state are separate columns and tables, and no incident,
-- classification, embedding, draft or publication table exists yet.
--
-- Identifiers are application-generated UUIDs, so no extension is required.
-- All text columns are TEXT: the source contains fields longer than 48,000
-- characters and nothing may truncate them.

-- One import of one file with one configuration. A structurally rejected
-- file never creates a batch; a batch is written in one transaction, so it
-- is never half present. The idempotency key covers the file hash and every
-- behaviour-changing configuration value, and is unique.
CREATE TABLE import_batches (
  id                    uuid        PRIMARY KEY,
  data_origin           text        NOT NULL CHECK (data_origin IN ('live', 'fixture', 'replay')),
  source_kind           text        NOT NULL CHECK (source_kind IN ('master', 'weekly')),
  review_label          text        CHECK (review_label IS NULL OR length(btrim(review_label)) > 0),
  source_basename       text        NOT NULL CHECK (
                                      length(source_basename) > 0
                                      AND position('/' IN source_basename) = 0
                                      AND position(E'\\' IN source_basename) = 0
                                    ),
  file_sha256           text        NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  byte_length           bigint      NOT NULL CHECK (byte_length >= 0),
  header_cells          jsonb       NOT NULL CHECK (jsonb_typeof(header_cells) = 'array'),
  importer_version      text        NOT NULL CHECK (length(importer_version) > 0),
  idempotency_key       text        NOT NULL UNIQUE CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  status                text        NOT NULL CHECK (status IN ('completed', 'completed_with_issues')),
  parsed_row_count      integer     NOT NULL CHECK (parsed_row_count >= 0),
  accepted_row_count    integer     NOT NULL CHECK (accepted_row_count >= 0),
  quarantined_row_count integer     NOT NULL CHECK (quarantined_row_count >= 0),
  started_at            timestamptz NOT NULL,
  completed_at          timestamptz,
  CONSTRAINT import_batches_weekly_label
    CHECK ((source_kind = 'weekly') = (review_label IS NOT NULL)),
  CONSTRAINT import_batches_counts
    CHECK (parsed_row_count = accepted_row_count + quarantined_row_count),
  CONSTRAINT import_batches_status_counts
    CHECK ((status = 'completed_with_issues') = (quarantined_row_count > 0))
);

-- Matching key only. Every source row keeps its original URL; rows whose
-- canonical form is equal reference the same group and are never merged.
CREATE TABLE url_groups (
  id            uuid        PRIMARY KEY,
  canonical_url text        NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- One logical CSV row. raw_cells is the exact ordered cell list including
-- blank-header positions; raw_fields maps every non-blank header, known or
-- unknown, to its exact cell. Recognized raw_* columns are copies of the
-- cells under the known header names, NULL only when the header is absent.
-- Parsed, normalized and derived values live in their own columns.
CREATE TABLE source_rows (
  id                       uuid        PRIMARY KEY,
  batch_id                 uuid        NOT NULL REFERENCES import_batches (id),
  row_number               integer     NOT NULL CHECK (row_number >= 1),
  data_origin              text        NOT NULL CHECK (data_origin IN ('live', 'fixture', 'replay')),
  status                   text        NOT NULL CHECK (status IN ('accepted', 'quarantined')),
  raw_cells                jsonb       NOT NULL CHECK (jsonb_typeof(raw_cells) = 'array'),
  raw_fields               jsonb       NOT NULL CHECK (jsonb_typeof(raw_fields) = 'object'),
  raw_ch                   text,
  raw_date_posted          text,
  raw_date_updated         text,
  raw_title                text,
  raw_author               text,
  raw_description          text,
  raw_summary              text,
  raw_url                  text,
  raw_category             text,
  posted_at                timestamptz,
  updated_at               timestamptz,
  normalized_title         text,
  derived_summary_text     text,
  derived_description_text text,
  text_transform           text        NOT NULL CHECK (length(text_transform) > 0),
  canonical_url            text,
  url_group_id             uuid        REFERENCES url_groups (id),
  row_hash                 text        NOT NULL CHECK (row_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT source_rows_batch_row UNIQUE (batch_id, row_number),
  CONSTRAINT source_rows_url_group CHECK ((canonical_url IS NULL) = (url_group_id IS NULL))
);

CREATE INDEX source_rows_url_group_idx ON source_rows (url_group_id);
CREATE INDEX source_rows_batch_status_idx ON source_rows (batch_id, status);

-- Stable machine-readable issues per row. message is a fixed diagnostic
-- chosen by the importer and never contains source content.
CREATE TABLE row_issues (
  id            uuid PRIMARY KEY,
  batch_id      uuid NOT NULL REFERENCES import_batches (id),
  source_row_id uuid NOT NULL REFERENCES source_rows (id),
  issue_code    text NOT NULL CHECK (issue_code ~ '^[a-z][a-z0-9_]*$'),
  field         text,
  severity      text NOT NULL CHECK (severity IN ('error', 'warning')),
  message       text NOT NULL CHECK (length(message) > 0)
);

CREATE INDEX row_issues_batch_code_idx ON row_issues (batch_id, issue_code);

-- A weekly review snapshot: the label of the week (for example CS79) and its
-- origin, one per weekly batch. Master imports never create one.
CREATE TABLE review_snapshots (
  id           uuid        PRIMARY KEY,
  batch_id     uuid        NOT NULL UNIQUE REFERENCES import_batches (id),
  review_label text        NOT NULL CHECK (length(btrim(review_label)) > 0),
  data_origin  text        NOT NULL CHECK (data_origin IN ('live', 'fixture', 'replay')),
  created_at   timestamptz NOT NULL
);

-- Human review state per source row, traceable to its snapshot. Separate
-- from the row's content and from any future machine classification.
CREATE TABLE review_entries (
  id            uuid PRIMARY KEY,
  snapshot_id   uuid NOT NULL REFERENCES review_snapshots (id),
  source_row_id uuid NOT NULL UNIQUE REFERENCES source_rows (id),
  raw_value     text,
  review_state  text NOT NULL CHECK (review_state IN ('selected', 'rejected', 'unreviewed'))
);

CREATE INDEX review_entries_snapshot_state_idx ON review_entries (snapshot_id, review_state);
