-- 0003_classification
--
-- Sprint 3 persistence for the deterministic high-recall classifier
-- (decision D21). Forward-only; migrations 0001 and 0002 are not altered.
--
-- Two tables. A classification run names exactly one import batch, one
-- classifier version, one ruleset version and one ruleset hash; a result
-- belongs to one run and one source row. The composite keys carry the batch
-- through both tables, so a run cannot mix batches and a result cannot point
-- at a row from another batch. That is the same relational discipline
-- migration 0002 applied to ingestion: a provenance contradiction is
-- impossible rather than merely unlikely.
--
-- Machine decisions live only here. Nothing in this migration writes, reads
-- or references `review_snapshots` or `review_entries`: a classification
-- decision is never a human review state, and the needs-review queue is
-- derived from a run rather than copied into the human review tables.

-- One execution of one ruleset over one batch. A run is written in a single
-- transaction and only ever reaches a completed state, so a failure leaves no
-- partial run behind. The count constraints make a short write impossible to
-- record as complete.
CREATE TABLE classification_runs (
  id                  uuid        PRIMARY KEY,
  batch_id            uuid        NOT NULL,
  data_origin         text        NOT NULL CHECK (data_origin IN ('live', 'fixture', 'replay')),
  classifier_version  text        NOT NULL CHECK (length(classifier_version) > 0),
  ruleset_version     text        NOT NULL CHECK (length(ruleset_version) > 0),
  ruleset_hash        text        NOT NULL CHECK (ruleset_hash ~ '^[0-9a-f]{64}$'),
  mode                text        NOT NULL CHECK (mode = 'rules'),
  idempotency_key     text        NOT NULL UNIQUE CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  status              text        NOT NULL CHECK (status = 'completed'),
  expected_row_count  integer     NOT NULL CHECK (expected_row_count >= 0),
  classified_row_count integer    NOT NULL CHECK (classified_row_count >= 0),
  include_count       integer     NOT NULL CHECK (include_count >= 0),
  exclude_count       integer     NOT NULL CHECK (exclude_count >= 0),
  review_count        integer     NOT NULL CHECK (review_count >= 0),
  started_at          timestamptz NOT NULL,
  completed_at        timestamptz NOT NULL,
  CONSTRAINT classification_runs_decision_counts
    CHECK (classified_row_count = include_count + exclude_count + review_count),
  CONSTRAINT classification_runs_complete
    CHECK (classified_row_count = expected_row_count),
  -- The run's batch must exist, and the run's origin must be that batch's
  -- origin: a run cannot claim a provenance its batch does not have.
  CONSTRAINT classification_runs_batch_origin_fk
    FOREIGN KEY (batch_id, data_origin) REFERENCES import_batches (id, data_origin),
  -- Parent key for the results' composite foreign key below.
  CONSTRAINT classification_runs_id_batch UNIQUE (id, batch_id)
);

CREATE INDEX classification_runs_batch_idx ON classification_runs (batch_id);

-- One decision for one source row in one run. `rationale_codes` and
-- `matched_signals` hold the classifier's own fixed vocabulary and the
-- policy's signal identifiers; neither ever holds a source excerpt.
CREATE TABLE classification_results (
  id              uuid        PRIMARY KEY,
  run_id          uuid        NOT NULL,
  batch_id        uuid        NOT NULL,
  source_row_id   uuid        NOT NULL,
  decision        text        NOT NULL CHECK (decision IN ('include', 'exclude', 'review')),
  rationale_codes jsonb       NOT NULL CHECK (jsonb_typeof(rationale_codes) = 'array'
                                              AND jsonb_array_length(rationale_codes) > 0),
  matched_signals jsonb       NOT NULL CHECK (jsonb_typeof(matched_signals) = 'array'),
  signal_score    integer     NOT NULL CHECK (signal_score >= 0),
  row_hash        text        NOT NULL CHECK (row_hash ~ '^[0-9a-f]{64}$'),
  created_at      timestamptz NOT NULL,
  -- Exactly one result per row per run.
  CONSTRAINT classification_results_run_row UNIQUE (run_id, source_row_id),
  -- The result's run must be a run of the result's batch.
  CONSTRAINT classification_results_run_batch_fk
    FOREIGN KEY (run_id, batch_id) REFERENCES classification_runs (id, batch_id),
  -- The result's source row must belong to the result's batch, so a result
  -- can never attach a decision to a row from another batch.
  CONSTRAINT classification_results_row_batch_fk
    FOREIGN KEY (source_row_id, batch_id) REFERENCES source_rows (id, batch_id)
);

CREATE INDEX classification_results_run_decision_idx ON classification_results (run_id, decision);
CREATE INDEX classification_results_source_row_idx ON classification_results (source_row_id);
