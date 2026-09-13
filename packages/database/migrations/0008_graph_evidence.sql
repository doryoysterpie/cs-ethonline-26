-- 0008_graph_evidence
--
-- Sprint 5, decision D25. Stores Graph signals, the associations between
-- canonical incidents and those signals, the resolved evidence state of each
-- incident, and the human decisions that produced it.
--
-- Five ideas the schema enforces rather than documents:
--
--   1. **No credential is storable.** There is no column for an Authorization
--      header, an API key or a credential-bearing URL. What is kept is the
--      sanitized request target, the validated response identity, a canonical
--      response digest and the block context: enough to explain or reproduce a
--      signal, and nothing that could authenticate as anyone.
--   2. **A signal cannot be substituted.** An association binds to the exact
--      signal, its signal run and its chain, and to the exact incident, its
--      clustering run and its batch. The evidence run itself declares which
--      clustering run and which signal run it covers, and composite keys make
--      a membership of any other run unrepresentable rather than merely
--      unlikely. This is the Sprint 4 provenance lesson applied before an
--      auditor has to find it again.
--   3. **A completed run is immutable**, as in Sprints 3 and 4, and its
--      counters are re-derived by the database rather than trusted from the
--      caller.
--   4. **A machine suggestion is not a human decision.** Suggestions live in
--      the association table; acceptance and rejection are append-only review
--      actions in their own table, each carrying its actor and a bounded
--      rationale. The machine record stays what the machine produced.
--   5. **Evidence text is bounded and control-free.** Every human-supplied
--      string is length-checked and refuses C0 controls, DEL, C1 controls,
--      U+2028 and U+2029 at the database, not only at the command line.
--
-- Migrations 0001 to 0007 are unchanged. Every function and trigger below is
-- created through `pg_catalog.format` with quoted identifiers, bound to the
-- schema being migrated, and stores `search_path = pg_catalog, <schema>,
-- pg_temp` with every relation named by schema. None is SECURITY DEFINER.

DO $migration$
DECLARE
  target text := pg_catalog.current_schema();
BEGIN
  IF target IS NULL OR target = '' THEN
    RAISE EXCEPTION 'migration 0008 has no target schema' USING ERRCODE = 'raise_exception';
  END IF;
  IF target = 'pg_temp' OR target LIKE 'pg\_temp\_%' OR target LIKE 'pg\_toast%' THEN
    RAISE EXCEPTION 'migration 0008 refuses a temporary or system target schema'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.clustering_runs') IS NULL
     OR pg_catalog.to_regclass(pg_catalog.quote_ident(target) || '.incident_clusters') IS NULL
  THEN
    RAISE EXCEPTION 'migration 0008 target schema does not hold the Sprint 4 clustering tables'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- -------------------------------------------------------------------------
  -- 1. Graph signal runs.
  --
  -- One ingestion of provider observations. `gateway_host` is the host alone,
  -- never a URL with a path, query or credential; `query_sha256` pins the
  -- document that was sent. Neither can carry a secret: the host is checked
  -- against a hostname shape and the digest against hexadecimal.

  EXECUTE pg_catalog.format($fmt$
    CREATE TABLE %1$I.graph_signal_runs (
      id                  uuid        PRIMARY KEY,
      data_origin         text        NOT NULL
                            CHECK (data_origin IN ('live', 'fixture', 'replay')),
      signal_version      text        NOT NULL CHECK (length(signal_version) > 0),
      contract_version    text        NOT NULL CHECK (length(contract_version) > 0),
      contract_hash       text        NOT NULL CHECK (contract_hash ~ '^[0-9a-f]{64}$'),
      query_sha256        text        NOT NULL CHECK (query_sha256 ~ '^[0-9a-f]{64}$'),
      gateway_host        text        NOT NULL
                            CHECK (gateway_host ~ '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$'),
      idempotency_key     text        NOT NULL UNIQUE
                            CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
      status              text        NOT NULL CHECK (status IN ('running', 'completed')),
      target_count        integer     NOT NULL CHECK (target_count >= 0),
      signal_count        integer     NOT NULL CHECK (signal_count >= 0),
      failed_target_count integer     NOT NULL CHECK (failed_target_count >= 0),
      started_at          timestamptz NOT NULL,
      completed_at        timestamptz,
      CONSTRAINT graph_signal_runs_completed_at
        CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
      CONSTRAINT graph_signal_runs_identity UNIQUE (id, data_origin)
    )
  $fmt$, target);

  -- -------------------------------------------------------------------------
  -- 2. Graph signals.
  --
  -- One normalized TVL-delta observation with its provider identity and block
  -- context. `response_digest` is the canonical digest of the validated
  -- response, so a stored signal can be checked against a re-fetched one
  -- without keeping the payload. The raw provider payload is deliberately not
  -- stored: it is provider-controlled text with no integrity guarantee and no
  -- use that the validated fields do not already serve.

  EXECUTE pg_catalog.format($fmt$
    CREATE TABLE %1$I.graph_signals (
      id                      uuid        PRIMARY KEY,
      signal_run_id           uuid        NOT NULL REFERENCES %1$I.graph_signal_runs (id),
      data_origin             text        NOT NULL
                                CHECK (data_origin IN ('live', 'fixture', 'replay')),
      chain                   text        NOT NULL CHECK (chain IN ('ethereum', 'base')),
      protocol_slug           text        NOT NULL CHECK (protocol_slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
      subgraph_deployment_id  text        CHECK (subgraph_deployment_id IS NULL
                                            OR subgraph_deployment_id ~ '^[A-Za-z0-9]{1,128}$'),
      block_number            bigint      CHECK (block_number IS NULL OR block_number >= 0),
      block_hash              text        CHECK (block_hash IS NULL OR block_hash ~ '^0x[0-9a-f]{64}$'),
      observed_at             timestamptz NOT NULL,
      baseline_observed_at    timestamptz NOT NULL,
      elapsed_seconds         integer     NOT NULL CHECK (elapsed_seconds >= 0),
      current_tvl_usd         numeric     NOT NULL,
      baseline_tvl_usd        numeric     NOT NULL,
      delta_usd               numeric     NOT NULL,
      delta_percent           numeric     NOT NULL,
      response_digest         text        NOT NULL CHECK (response_digest ~ '^[0-9a-f]{64}$'),
      created_at              timestamptz NOT NULL,
      CONSTRAINT graph_signals_run_origin_fk
        FOREIGN KEY (signal_run_id, data_origin)
        REFERENCES %1$I.graph_signal_runs (id, data_origin),
      CONSTRAINT graph_signals_run_target UNIQUE (signal_run_id, chain, protocol_slug),
      CONSTRAINT graph_signals_identity UNIQUE (id, signal_run_id, chain)
    )
  $fmt$, target);
  EXECUTE pg_catalog.format(
    'CREATE INDEX graph_signals_target_idx ON %1$I.graph_signals (chain, protocol_slug, observed_at)',
    target);

  -- -------------------------------------------------------------------------
  -- 3. Evidence runs.
  --
  -- One correlation and resolution pass over exactly one clustering run and
  -- exactly one signal run. Naming both in the run's identity is what lets an
  -- association bind to them by composite key.

  EXECUTE pg_catalog.format($fmt$
    CREATE TABLE %1$I.evidence_runs (
      id                       uuid        PRIMARY KEY,
      clustering_run_id        uuid        NOT NULL,
      batch_id                 uuid        NOT NULL,
      signal_run_id            uuid        NOT NULL REFERENCES %1$I.graph_signal_runs (id),
      data_origin              text        NOT NULL
                                 CHECK (data_origin IN ('live', 'fixture', 'replay')),
      resolver_version         text        NOT NULL CHECK (length(resolver_version) > 0),
      contract_version         text        NOT NULL CHECK (length(contract_version) > 0),
      contract_hash            text        NOT NULL CHECK (contract_hash ~ '^[0-9a-f]{64}$'),
      idempotency_key          text        NOT NULL UNIQUE
                                 CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
      status                   text        NOT NULL CHECK (status IN ('running', 'completed')),
      incident_count           integer     NOT NULL CHECK (incident_count >= 0),
      signal_count             integer     NOT NULL CHECK (signal_count >= 0),
      suggestion_count         integer     NOT NULL CHECK (suggestion_count >= 0),
      reported_only_count      integer     NOT NULL CHECK (reported_only_count >= 0),
      onchain_observed_count   integer     NOT NULL CHECK (onchain_observed_count >= 0),
      corroborated_count       integer     NOT NULL CHECK (corroborated_count >= 0),
      contradicted_count       integer     NOT NULL CHECK (contradicted_count >= 0),
      started_at               timestamptz NOT NULL,
      completed_at             timestamptz,
      CONSTRAINT evidence_runs_completed_at
        CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
      CONSTRAINT evidence_runs_state_counts
        CHECK (incident_count = reported_only_count + onchain_observed_count
                              + corroborated_count + contradicted_count),
      CONSTRAINT evidence_runs_clustering_fk
        FOREIGN KEY (clustering_run_id, batch_id)
        REFERENCES %1$I.clustering_runs (id, batch_id),
      CONSTRAINT evidence_runs_identity
        UNIQUE (id, clustering_run_id, batch_id, signal_run_id)
    )
  $fmt$, target);

  -- -------------------------------------------------------------------------
  -- 3b. Incident subjects.
  --
  -- Which chain and which protocol an incident is *about*, recorded
  -- explicitly. This is the only thing correlation matches on, and it is
  -- deliberately not inferred from headlines, summaries or bodies: Sprint 5
  -- implements no automatic protocol extraction at all, so an incident
  -- acquires a subject because a person recorded one, with their identity and
  -- a stable reason code beside it.
  --
  -- An incident without a subject simply never correlates. That is the
  -- intended outcome rather than a gap: a wrong link between a report and a
  -- protocol is far more damaging than a missing one.

  EXECUTE pg_catalog.format($fmt$
    CREATE TABLE %1$I.incident_subjects (
      id                  uuid        PRIMARY KEY,
      clustering_run_id   uuid        NOT NULL,
      batch_id            uuid        NOT NULL,
      incident_cluster_id uuid        NOT NULL,
      chain               text        NOT NULL CHECK (chain IN ('ethereum', 'base')),
      protocol_slug       text        NOT NULL
                            CHECK (protocol_slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
      actor               text        NOT NULL CHECK (actor ~ '^[a-z][a-z0-9_.:-]{1,63}$'),
      reason_code         text        NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{2,63}$'),
      created_at          timestamptz NOT NULL,
      CONSTRAINT incident_subjects_incident_fk
        FOREIGN KEY (incident_cluster_id, clustering_run_id, batch_id)
        REFERENCES %1$I.incident_clusters (id, clustering_run_id, batch_id),
      CONSTRAINT incident_subjects_unique UNIQUE (clustering_run_id, incident_cluster_id)
    )
  $fmt$, target);

  -- -------------------------------------------------------------------------
  -- 4. Incident-to-signal associations.
  --
  -- The composite keys are the point. An association names its evidence run,
  -- and through that run's identity it can only name that run's clustering run,
  -- batch and signal run. It then binds to the exact incident of that
  -- clustering run and the exact signal of that signal run and chain. A
  -- cross-run, cross-batch or cross-chain substitution is not rejected at
  -- write time by a check: it cannot be written at all.

  EXECUTE pg_catalog.format($fmt$
    CREATE TABLE %1$I.incident_signal_associations (
      id                  uuid        PRIMARY KEY,
      evidence_run_id     uuid        NOT NULL,
      clustering_run_id   uuid        NOT NULL,
      batch_id            uuid        NOT NULL,
      signal_run_id       uuid        NOT NULL,
      incident_cluster_id uuid        NOT NULL,
      signal_id           uuid        NOT NULL,
      chain               text        NOT NULL CHECK (chain IN ('ethereum', 'base')),
      claim_id            uuid,
      relation            text        NOT NULL
                            CHECK (relation IN ('supports', 'conflicts', 'context')),
      status              text        NOT NULL
                            CHECK (status IN ('suggested', 'accepted', 'rejected')),
      reason_codes        jsonb       NOT NULL
                            CHECK (jsonb_typeof(reason_codes) = 'array'
                                   AND jsonb_array_length(reason_codes) BETWEEN 1 AND 16),
      offset_seconds      integer     NOT NULL,
      created_at          timestamptz NOT NULL,
      CONSTRAINT incident_signal_associations_run_fk
        FOREIGN KEY (evidence_run_id, clustering_run_id, batch_id, signal_run_id)
        REFERENCES %1$I.evidence_runs (id, clustering_run_id, batch_id, signal_run_id),
      CONSTRAINT incident_signal_associations_incident_fk
        FOREIGN KEY (incident_cluster_id, clustering_run_id, batch_id)
        REFERENCES %1$I.incident_clusters (id, clustering_run_id, batch_id),
      CONSTRAINT incident_signal_associations_signal_fk
        FOREIGN KEY (signal_id, signal_run_id, chain)
        REFERENCES %1$I.graph_signals (id, signal_run_id, chain),
      CONSTRAINT incident_signal_associations_unique
        UNIQUE (evidence_run_id, incident_cluster_id, signal_id),
      CONSTRAINT incident_signal_associations_identity UNIQUE (id, evidence_run_id)
    )
  $fmt$, target);

  -- -------------------------------------------------------------------------
  -- 5. Human evidence decisions, append-only.
  --
  -- Accepting or rejecting a suggestion is recorded here, never by editing the
  -- suggestion. The current status of an association is the machine's
  -- suggestion plus the ordered decisions over it, exactly as Sprint 4 treats
  -- merge and split.

  EXECUTE pg_catalog.format($fmt$
    CREATE TABLE %1$I.evidence_review_actions (
      id              uuid        PRIMARY KEY,
      evidence_run_id uuid        NOT NULL,
      association_id  uuid        NOT NULL,
      operation       text        NOT NULL CHECK (operation IN ('accept', 'reject')),
      relation        text        NOT NULL
                        CHECK (relation IN ('supports', 'conflicts', 'context')),
      claim_id        uuid,
      reason_code     text        NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{2,63}$'),
      rationale       text,
      actor           text        NOT NULL CHECK (actor ~ '^[a-z][a-z0-9_.:-]{1,63}$'),
      prior_revision  integer     NOT NULL CHECK (prior_revision >= 0),
      resulting_revision integer  NOT NULL CHECK (resulting_revision > 0),
      idempotency_key text        NOT NULL CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
      created_at      timestamptz NOT NULL,
      CONSTRAINT evidence_actions_revision CHECK (resulting_revision = prior_revision + 1),
      CONSTRAINT evidence_actions_run_revision UNIQUE (evidence_run_id, resulting_revision),
      CONSTRAINT evidence_actions_idempotent UNIQUE (evidence_run_id, idempotency_key),
      CONSTRAINT evidence_actions_association_fk
        FOREIGN KEY (association_id, evidence_run_id)
        REFERENCES %1$I.incident_signal_associations (id, evidence_run_id),
      -- The same character policy migration 0007 gave clustering notes:
      -- 1 to 280 characters, and no C0 control, DEL, C1 control, U+2028 or
      -- U+2029. An empty rationale is not a rationale; absence is NULL.
      CONSTRAINT evidence_actions_rationale_policy
        CHECK (rationale IS NULL
               OR (pg_catalog.length(rationale) BETWEEN 1 AND 280
                   AND rationale !~ '[\u0000-\u001f\u007f-\u009f\u2028\u2029]'))
    )
  $fmt$, target);

  -- -------------------------------------------------------------------------
  -- 6. Resolved evidence states.
  --
  -- One row per incident per evidence run. The state vocabulary is the
  -- contract's four values and nothing else, and the row records the reason
  -- and, when the deciding association named one, the claim the state is
  -- about. A state is about a claim or it is about nothing.

  EXECUTE pg_catalog.format($fmt$
    CREATE TABLE %1$I.incident_evidence_states (
      id                  uuid        PRIMARY KEY,
      evidence_run_id     uuid        NOT NULL,
      clustering_run_id   uuid        NOT NULL,
      batch_id            uuid        NOT NULL,
      signal_run_id       uuid        NOT NULL,
      incident_cluster_id uuid        NOT NULL,
      state               text        NOT NULL
                            CHECK (state IN ('reported_only', 'onchain_observed',
                                             'corroborated', 'contradicted')),
      reason_code         text        NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{2,63}$'),
      claim_id            uuid,
      accepted_association_count integer NOT NULL CHECK (accepted_association_count >= 0),
      created_at          timestamptz NOT NULL,
      CONSTRAINT incident_evidence_states_run_fk
        FOREIGN KEY (evidence_run_id, clustering_run_id, batch_id, signal_run_id)
        REFERENCES %1$I.evidence_runs (id, clustering_run_id, batch_id, signal_run_id),
      CONSTRAINT incident_evidence_states_incident_fk
        FOREIGN KEY (incident_cluster_id, clustering_run_id, batch_id)
        REFERENCES %1$I.incident_clusters (id, clustering_run_id, batch_id),
      CONSTRAINT incident_evidence_states_unique
        UNIQUE (evidence_run_id, incident_cluster_id),
      -- A state past `onchain_observed` must rest on something accepted. The
      -- database refuses the combination outright, so no code path can record
      -- a corroboration or a contradiction with nothing behind it.
      CONSTRAINT incident_evidence_states_supported
        CHECK (state IN ('reported_only', 'onchain_observed') OR accepted_association_count > 0),
      -- `corroborated` and `contradicted` are about a specific claim.
      CONSTRAINT incident_evidence_states_claim
        CHECK (state IN ('reported_only', 'onchain_observed') OR claim_id IS NOT NULL)
    )
  $fmt$, target);

  -- -------------------------------------------------------------------------
  -- 7. Immutability and completion validation.
  --
  -- Both run tables follow the Sprint 3 and Sprint 4 pattern: a run is
  -- inserted `running`, a completed run is frozen, and the transition to
  -- `completed` re-derives every counter from the rows actually stored rather
  -- than trusting what the caller supplied.

  EXECUTE pg_catalog.format($fmt$
    CREATE FUNCTION %1$I.graph_signal_run_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, %1$I, pg_temp
    AS $guard$
    DECLARE
      derived_signals integer;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'running' THEN
          RAISE EXCEPTION 'graph signal run must be inserted in the running state'
            USING ERRCODE = 'raise_exception';
        END IF;
        RETURN NEW;
      END IF;
      IF TG_OP = 'DELETE' THEN
        IF OLD.status = 'completed' THEN
          RAISE EXCEPTION 'completed graph signal run is immutable'
            USING ERRCODE = 'raise_exception';
        END IF;
        RETURN OLD;
      END IF;
      IF OLD.status = 'completed' THEN
        RAISE EXCEPTION 'completed graph signal run is immutable'
          USING ERRCODE = 'raise_exception';
      END IF;
      IF NEW.id <> OLD.id
         OR NEW.data_origin <> OLD.data_origin
         OR NEW.contract_hash <> OLD.contract_hash
         OR NEW.query_sha256 <> OLD.query_sha256
         OR NEW.gateway_host <> OLD.gateway_host
         OR NEW.idempotency_key <> OLD.idempotency_key
         OR NEW.started_at <> OLD.started_at THEN
        RAISE EXCEPTION 'graph signal run provenance is immutable'
          USING ERRCODE = 'raise_exception';
      END IF;
      IF NEW.status = 'completed' THEN
        SELECT count(*) INTO derived_signals
          FROM %1$I.graph_signals WHERE signal_run_id = NEW.id;
        IF NEW.signal_count <> derived_signals THEN
          RAISE EXCEPTION 'graph signal run counters do not match its stored signals'
            USING ERRCODE = 'raise_exception';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $guard$
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER graph_signal_runs_guard
      BEFORE INSERT OR UPDATE OR DELETE ON %1$I.graph_signal_runs
      FOR EACH ROW EXECUTE FUNCTION %1$I.graph_signal_run_guard()
  $fmt$, target);

  EXECUTE pg_catalog.format($fmt$
    CREATE FUNCTION %1$I.evidence_run_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, %1$I, pg_temp
    AS $guard$
    DECLARE
      derived_total   integer;
      derived_reported integer;
      derived_observed integer;
      derived_corroborated integer;
      derived_contradicted integer;
      cluster_total   integer;
      derived_suggestions integer;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'running' THEN
          RAISE EXCEPTION 'evidence run must be inserted in the running state'
            USING ERRCODE = 'raise_exception';
        END IF;
        RETURN NEW;
      END IF;
      IF TG_OP = 'DELETE' THEN
        IF OLD.status = 'completed' THEN
          RAISE EXCEPTION 'completed evidence run is immutable'
            USING ERRCODE = 'raise_exception';
        END IF;
        RETURN OLD;
      END IF;
      IF OLD.status = 'completed' THEN
        RAISE EXCEPTION 'completed evidence run is immutable'
          USING ERRCODE = 'raise_exception';
      END IF;
      IF NEW.id <> OLD.id
         OR NEW.clustering_run_id <> OLD.clustering_run_id
         OR NEW.batch_id <> OLD.batch_id
         OR NEW.signal_run_id <> OLD.signal_run_id
         OR NEW.data_origin <> OLD.data_origin
         OR NEW.contract_hash <> OLD.contract_hash
         OR NEW.idempotency_key <> OLD.idempotency_key
         OR NEW.started_at <> OLD.started_at THEN
        RAISE EXCEPTION 'evidence run provenance is immutable'
          USING ERRCODE = 'raise_exception';
      END IF;
      IF NEW.status = 'completed' THEN
        SELECT count(*),
               count(*) FILTER (WHERE state = 'reported_only'),
               count(*) FILTER (WHERE state = 'onchain_observed'),
               count(*) FILTER (WHERE state = 'corroborated'),
               count(*) FILTER (WHERE state = 'contradicted')
          INTO derived_total, derived_reported, derived_observed,
               derived_corroborated, derived_contradicted
          FROM %1$I.incident_evidence_states WHERE evidence_run_id = NEW.id;

        SELECT count(*) INTO cluster_total
          FROM %1$I.incident_clusters WHERE clustering_run_id = NEW.clustering_run_id;

        SELECT count(*) INTO derived_suggestions
          FROM %1$I.incident_signal_associations WHERE evidence_run_id = NEW.id;

        IF derived_total <> cluster_total THEN
          RAISE EXCEPTION 'evidence run does not resolve every incident of its clustering run'
            USING ERRCODE = 'raise_exception';
        END IF;
        IF NEW.incident_count <> derived_total
           OR NEW.reported_only_count <> derived_reported
           OR NEW.onchain_observed_count <> derived_observed
           OR NEW.corroborated_count <> derived_corroborated
           OR NEW.contradicted_count <> derived_contradicted
           OR NEW.suggestion_count <> derived_suggestions THEN
          RAISE EXCEPTION 'evidence run counters do not match its stored rows'
            USING ERRCODE = 'raise_exception';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $guard$
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER evidence_runs_guard
      BEFORE INSERT OR UPDATE OR DELETE ON %1$I.evidence_runs
      FOR EACH ROW EXECUTE FUNCTION %1$I.evidence_run_guard()
  $fmt$, target);

  -- Output of a completed run of either kind is frozen, and a review action is
  -- append-only whatever the run's status.
  EXECUTE pg_catalog.format($fmt$
    CREATE FUNCTION %1$I.evidence_output_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, %1$I, pg_temp
    AS $guard$
    DECLARE
      run_status text;
      run_id     uuid;
    BEGIN
      IF TG_TABLE_NAME = 'graph_signals' THEN
        run_id := coalesce(NEW.signal_run_id, OLD.signal_run_id);
        SELECT status INTO run_status
          FROM %1$I.graph_signal_runs WHERE id = run_id FOR SHARE;
      ELSE
        run_id := coalesce(NEW.evidence_run_id, OLD.evidence_run_id);
        SELECT status INTO run_status
          FROM %1$I.evidence_runs WHERE id = run_id FOR SHARE;
      END IF;
      IF run_status = 'completed' THEN
        RAISE EXCEPTION 'output of a completed evidence run is immutable'
          USING ERRCODE = 'raise_exception';
      END IF;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END;
    $guard$
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER graph_signals_output_guard
      BEFORE INSERT OR UPDATE OR DELETE ON %1$I.graph_signals
      FOR EACH ROW EXECUTE FUNCTION %1$I.evidence_output_guard()
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER incident_evidence_states_output_guard
      BEFORE INSERT OR UPDATE OR DELETE ON %1$I.incident_evidence_states
      FOR EACH ROW EXECUTE FUNCTION %1$I.evidence_output_guard()
  $fmt$, target);

  -- A suggestion is written once. Its status is never edited: acceptance and
  -- rejection are recorded as review actions, and the effective status is
  -- replayed from the suggestion plus the ordered actions.
  EXECUTE pg_catalog.format($fmt$
    CREATE FUNCTION %1$I.association_append_only_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, %1$I, pg_temp
    AS $guard$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'suggested' THEN
          RAISE EXCEPTION 'an association is written as a suggestion and decided by review'
            USING ERRCODE = 'raise_exception';
        END IF;
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'an association is append-only; record a review action instead'
        USING ERRCODE = 'raise_exception';
    END;
    $guard$
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER incident_signal_associations_guard
      BEFORE INSERT OR UPDATE OR DELETE ON %1$I.incident_signal_associations
      FOR EACH ROW EXECUTE FUNCTION %1$I.association_append_only_guard()
  $fmt$, target);

  EXECUTE pg_catalog.format($fmt$
    CREATE FUNCTION %1$I.evidence_action_append_only_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, %1$I, pg_temp
    AS $guard$
    BEGIN
      IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
      RAISE EXCEPTION 'evidence review history is append-only'
        USING ERRCODE = 'raise_exception';
    END;
    $guard$
  $fmt$, target);
  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER evidence_review_actions_guard
      BEFORE UPDATE OR DELETE ON %1$I.evidence_review_actions
      FOR EACH ROW EXECUTE FUNCTION %1$I.evidence_action_append_only_guard()
  $fmt$, target);
  -- A recorded subject is a decision too, so it is append-only for the same
  -- reason a review action is: correcting one means recording a new incident
  -- cluster, not quietly rewriting what a person said.
  EXECUTE pg_catalog.format($fmt$
    CREATE TRIGGER incident_subjects_guard
      BEFORE UPDATE OR DELETE ON %1$I.incident_subjects
      FOR EACH ROW EXECUTE FUNCTION %1$I.evidence_action_append_only_guard()
  $fmt$, target);
END
$migration$;
