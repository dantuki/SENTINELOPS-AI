BEGIN;

-- Append-only application audit trail: no UPDATE/DELETE is issued by the API.
-- Database-level immutability depends on deployment roles and is deliberately not claimed here.
ALTER TABLE documents
    ADD CONSTRAINT uq_documents_id_project_source
    UNIQUE (id, project_id, source_id);

CREATE TABLE retrieval_events (
    request_id UUID NOT NULL,
    run_id UUID NOT NULL,
    project_id UUID NOT NULL,
    incident_id TEXT,
    retrieved_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pk_retrieval_events PRIMARY KEY (request_id),
    CONSTRAINT uq_retrieval_events_run_request UNIQUE (run_id, request_id),
    CONSTRAINT uq_retrieval_events_request_project UNIQUE (request_id, project_id),
    CONSTRAINT fk_retrieval_events_project
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT
);

CREATE TABLE retrieval_event_items (
    request_id UUID NOT NULL,
    rank INTEGER NOT NULL,
    chunk_id UUID NOT NULL,
    document_id UUID NOT NULL,
    source_id UUID NOT NULL,
    project_id UUID NOT NULL,
    ordinal INTEGER NOT NULL,
    score DOUBLE PRECISION NOT NULL,
    content_sha256 TEXT NOT NULL,
    evidence_scope TEXT NOT NULL,
    retrieved_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pk_retrieval_event_items PRIMARY KEY (request_id, rank),
    CONSTRAINT uq_retrieval_event_items_request_chunk UNIQUE (request_id, chunk_id),
    CONSTRAINT ck_retrieval_event_items_rank CHECK (rank > 0),
    CONSTRAINT ck_retrieval_event_items_ordinal CHECK (ordinal >= 0),
    CONSTRAINT ck_retrieval_event_items_score
      CHECK (
        score > '-Infinity'::double precision
        AND score < 'Infinity'::double precision
      ),
    CONSTRAINT ck_retrieval_event_items_content_sha256
      CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_retrieval_event_items_evidence_scope
      CHECK (evidence_scope IN ('incident_specific', 'project_context', 'other_incident', 'unknown_scope')),
    CONSTRAINT fk_retrieval_event_items_event_project
      FOREIGN KEY (request_id, project_id)
      REFERENCES retrieval_events(request_id, project_id) ON DELETE RESTRICT,
    CONSTRAINT fk_retrieval_event_items_chunk_lineage
      FOREIGN KEY (chunk_id, project_id, document_id)
      REFERENCES document_chunks(id, project_id, document_id) ON DELETE RESTRICT,
    CONSTRAINT fk_retrieval_event_items_document_project
      FOREIGN KEY (document_id, project_id)
      REFERENCES documents(id, project_id) ON DELETE RESTRICT,
    CONSTRAINT fk_retrieval_event_items_document_source_project
      FOREIGN KEY (document_id, project_id, source_id)
      REFERENCES documents(id, project_id, source_id) ON DELETE RESTRICT,
    CONSTRAINT fk_retrieval_event_items_source_project
      FOREIGN KEY (source_id, project_id)
      REFERENCES project_sources(id, project_id) ON DELETE RESTRICT
);

CREATE INDEX idx_retrieval_events_run_project ON retrieval_events (run_id, project_id, retrieved_at DESC);
CREATE INDEX idx_retrieval_event_items_request ON retrieval_event_items (request_id, rank);

COMMIT;
