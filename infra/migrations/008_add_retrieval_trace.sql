BEGIN;

-- Append-only application audit trail: no UPDATE/DELETE is issued by the API.
-- Database-level immutability depends on deployment roles and is deliberately not claimed here.
CREATE TABLE retrieval_events (
    request_id UUID PRIMARY KEY,
    run_id UUID NOT NULL,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    incident_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_retrieval_events_run_request UNIQUE (run_id, request_id)
);

CREATE TABLE retrieval_event_items (
    request_id UUID NOT NULL REFERENCES retrieval_events(request_id) ON DELETE RESTRICT,
    rank INTEGER NOT NULL CHECK (rank > 0),
    chunk_id UUID NOT NULL,
    document_id UUID NOT NULL,
    source_id UUID NOT NULL,
    project_id UUID NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    score DOUBLE PRECISION NOT NULL CHECK (isfinite(score)),
    content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    evidence_scope TEXT NOT NULL CHECK (evidence_scope IN ('incident_specific', 'project_context', 'other_incident', 'unknown_scope')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (request_id, rank),
    UNIQUE (request_id, chunk_id),
    FOREIGN KEY (chunk_id, project_id, document_id)
      REFERENCES document_chunks(id, project_id, document_id) ON DELETE RESTRICT,
    FOREIGN KEY (document_id, project_id)
      REFERENCES documents(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY (source_id, project_id)
      REFERENCES project_sources(id, project_id) ON DELETE RESTRICT
);

CREATE INDEX idx_retrieval_events_run_project ON retrieval_events (run_id, project_id, created_at DESC);
CREATE INDEX idx_retrieval_event_items_request ON retrieval_event_items (request_id, rank);

COMMIT;
