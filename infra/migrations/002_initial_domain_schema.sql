
BEGIN;

-- 1. Workspaces: contenedor superior de los proyectos.
CREATE TABLE workspaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT NOT NULL UNIQUE
        CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    name TEXT NOT NULL
        CHECK (btrim(name) <> ''),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'archived')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Projects: unidades de trabajo dentro de un workspace.
CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    slug TEXT NOT NULL
        CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    name TEXT NOT NULL
        CHECK (btrim(name) <> ''),
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'archived')),
    settings JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(settings) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_projects_workspace_slug
        UNIQUE (workspace_id, slug),

    CONSTRAINT fk_projects_workspace
        FOREIGN KEY (workspace_id)
        REFERENCES workspaces (id)
        ON DELETE RESTRICT
);

-- 3. Project sources: orígenes autorizados de información.
CREATE TABLE project_sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL,
    source_type TEXT NOT NULL
        CHECK (
            source_type IN (
                'file_upload',
                'git_repository',
                'web_url',
                'manual',
                'log_bundle'
            )
        ),
    name TEXT NOT NULL
        CHECK (btrim(name) <> ''),
    locator TEXT NOT NULL
        CHECK (btrim(locator) <> ''),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (
            status IN ('pending', 'active', 'disabled', 'failed')
        ),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(metadata) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_project_sources_id_project
        UNIQUE (id, project_id),

    CONSTRAINT uq_project_sources_locator
        UNIQUE (project_id, source_type, locator),

    CONSTRAINT fk_project_sources_project
        FOREIGN KEY (project_id)
        REFERENCES projects (id)
        ON DELETE RESTRICT
);

-- 4. Documents: documentos procesados o pendientes de procesar.
CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL,
    source_id UUID NOT NULL,
    source_document_key TEXT,
    title TEXT NOT NULL
        CHECK (btrim(title) <> ''),
    media_type TEXT,
    content_sha256 TEXT
        CHECK (
            content_sha256 IS NULL
            OR content_sha256 ~ '^[0-9a-f]{64}$'
        ),
    extracted_text TEXT,
    status TEXT NOT NULL DEFAULT 'discovered'
        CHECK (
            status IN (
                'discovered',
                'processing',
                'indexed',
                'failed',
                'archived'
            )
        ),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(metadata) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_documents_id_project
        UNIQUE (id, project_id),

    CONSTRAINT uq_documents_source_key
        UNIQUE (project_id, source_id, source_document_key),

    CONSTRAINT fk_documents_project
        FOREIGN KEY (project_id)
        REFERENCES projects (id)
        ON DELETE RESTRICT,

    CONSTRAINT fk_documents_source_project
        FOREIGN KEY (source_id, project_id)
        REFERENCES project_sources (id, project_id)
        ON DELETE RESTRICT
);

-- 5. Document chunks: fragmentos utilizados por el futuro pipeline RAG.
-- La dimensión del embedding se agregará cuando se seleccione el modelo.
CREATE TABLE document_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL,
    document_id UUID NOT NULL,
    ordinal INTEGER NOT NULL
        CHECK (ordinal >= 0),
    content TEXT NOT NULL
        CHECK (btrim(content) <> ''),
    token_count INTEGER
        CHECK (token_count IS NULL OR token_count >= 0),
    start_offset INTEGER,
    end_offset INTEGER,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(metadata) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_document_chunks_document_ordinal
        UNIQUE (document_id, ordinal),

    CONSTRAINT uq_document_chunks_id_project_document
        UNIQUE (id, project_id, document_id),

    CONSTRAINT ck_document_chunks_offsets
        CHECK (
            (start_offset IS NULL AND end_offset IS NULL)
            OR (
                start_offset IS NOT NULL
                AND end_offset IS NOT NULL
                AND start_offset >= 0
                AND end_offset > start_offset
            )
        ),

    CONSTRAINT fk_document_chunks_project
        FOREIGN KEY (project_id)
        REFERENCES projects (id)
        ON DELETE RESTRICT,

    CONSTRAINT fk_document_chunks_document_project
        FOREIGN KEY (document_id, project_id)
        REFERENCES documents (id, project_id)
        ON DELETE RESTRICT
);

-- 6. Incidents: problemas reportados para un proyecto.
CREATE TABLE incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL,
    external_reference TEXT,
    title TEXT NOT NULL
        CHECK (btrim(title) <> ''),
    description TEXT,
    service_name TEXT,
    severity TEXT NOT NULL DEFAULT 'unknown'
        CHECK (
            severity IN (
                'critical',
                'high',
                'medium',
                'low',
                'informational',
                'unknown'
            )
        ),
    status TEXT NOT NULL DEFAULT 'new'
        CHECK (
            status IN (
                'new',
                'triaged',
                'investigating',
                'resolved',
                'closed'
            )
        ),
    context JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(context) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_incidents_id_project
        UNIQUE (id, project_id),

    CONSTRAINT fk_incidents_project
        FOREIGN KEY (project_id)
        REFERENCES projects (id)
        ON DELETE RESTRICT
);

-- 7. Investigations: ejecuciones de investigación de un incidente.
CREATE TABLE investigations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL,
    incident_id UUID NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (
            status IN (
                'queued',
                'running',
                'succeeded',
                'failed',
                'cancelled'
            )
        ),
    input_context JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(input_context) = 'object'),
    result JSONB
        CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
    failure_code TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_investigations_id_project
        UNIQUE (id, project_id),

    CONSTRAINT ck_investigations_lifecycle
        CHECK (
            (
                status = 'queued'
                AND started_at IS NULL
                AND completed_at IS NULL
            )
            OR (
                status = 'running'
                AND started_at IS NOT NULL
                AND completed_at IS NULL
            )
            OR (
                status IN ('succeeded', 'failed', 'cancelled')
                AND started_at IS NOT NULL
                AND completed_at IS NOT NULL
                AND completed_at >= started_at
            )
        ),

    CONSTRAINT fk_investigations_project
        FOREIGN KEY (project_id)
        REFERENCES projects (id)
        ON DELETE RESTRICT,

    CONSTRAINT fk_investigations_incident_project
        FOREIGN KEY (incident_id, project_id)
        REFERENCES incidents (id, project_id)
        ON DELETE RESTRICT
);

-- 8. Evidence records: evidencias asociadas a una investigación.
CREATE TABLE evidence_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL,
    investigation_id UUID NOT NULL,
    evidence_type TEXT NOT NULL
        CHECK (
            evidence_type IN (
                'document_chunk',
                'document',
                'tool_result',
                'log_excerpt',
                'manual_note',
                'other'
            )
        ),
    document_id UUID,
    chunk_id UUID,
    title TEXT NOT NULL
        CHECK (btrim(title) <> ''),
    excerpt TEXT,
    locator TEXT,
    reference_uri TEXT,
    attributes JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(attributes) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_evidence_reference_type
        CHECK (
            (
                evidence_type = 'document_chunk'
                AND document_id IS NOT NULL
                AND chunk_id IS NOT NULL
            )
            OR (
                evidence_type = 'document'
                AND document_id IS NOT NULL
                AND chunk_id IS NULL
            )
            OR (
                evidence_type IN (
                    'tool_result',
                    'log_excerpt',
                    'manual_note',
                    'other'
                )
                AND document_id IS NULL
                AND chunk_id IS NULL
            )
        ),

    CONSTRAINT fk_evidence_project
        FOREIGN KEY (project_id)
        REFERENCES projects (id)
        ON DELETE RESTRICT,

    CONSTRAINT fk_evidence_investigation_project
        FOREIGN KEY (investigation_id, project_id)
        REFERENCES investigations (id, project_id)
        ON DELETE RESTRICT,

    CONSTRAINT fk_evidence_document_project
        FOREIGN KEY (document_id, project_id)
        REFERENCES documents (id, project_id)
        ON DELETE RESTRICT,

    CONSTRAINT fk_evidence_chunk_document_project
        FOREIGN KEY (chunk_id, project_id, document_id)
        REFERENCES document_chunks (id, project_id, document_id)
        ON DELETE RESTRICT
);

-- Índices para consultas habituales y filtros por proyecto.
CREATE INDEX idx_projects_workspace_status
    ON projects (workspace_id, status);

CREATE INDEX idx_project_sources_project_status
    ON project_sources (project_id, status);

CREATE INDEX idx_documents_project_status_created
    ON documents (project_id, status, created_at DESC);

CREATE INDEX idx_documents_source_project
    ON documents (source_id, project_id);

CREATE INDEX idx_document_chunks_project_document_order
    ON document_chunks (project_id, document_id, ordinal);

CREATE INDEX idx_document_chunks_document_project
    ON document_chunks (document_id, project_id);

CREATE INDEX idx_incidents_project_status_created
    ON incidents (project_id, status, created_at DESC);

CREATE INDEX idx_investigations_project_status_created
    ON investigations (project_id, status, created_at DESC);

CREATE INDEX idx_investigations_incident_project_created
    ON investigations (incident_id, project_id, created_at DESC);

CREATE INDEX idx_evidence_project_investigation_created
    ON evidence_records (project_id, investigation_id, created_at DESC);

CREATE INDEX idx_evidence_investigation_project
    ON evidence_records (investigation_id, project_id);

CREATE INDEX idx_evidence_document_project
    ON evidence_records (document_id, project_id)
    WHERE document_id IS NOT NULL;

CREATE INDEX idx_evidence_chunk_project_document
    ON evidence_records (chunk_id, project_id, document_id)
    WHERE chunk_id IS NOT NULL;

-- Mantener updated_at consistente para las tablas mutables.
CREATE OR REPLACE FUNCTION sentinelops_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_workspaces_updated_at
    BEFORE UPDATE ON workspaces
    FOR EACH ROW EXECUTE FUNCTION sentinelops_touch_updated_at();

CREATE TRIGGER trg_projects_updated_at
    BEFORE UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION sentinelops_touch_updated_at();

CREATE TRIGGER trg_project_sources_updated_at
    BEFORE UPDATE ON project_sources
    FOR EACH ROW EXECUTE FUNCTION sentinelops_touch_updated_at();

CREATE TRIGGER trg_documents_updated_at
    BEFORE UPDATE ON documents
    FOR EACH ROW EXECUTE FUNCTION sentinelops_touch_updated_at();

CREATE TRIGGER trg_incidents_updated_at
    BEFORE UPDATE ON incidents
    FOR EACH ROW EXECUTE FUNCTION sentinelops_touch_updated_at();

CREATE TRIGGER trg_investigations_updated_at
    BEFORE UPDATE ON investigations
    FOR EACH ROW EXECUTE FUNCTION sentinelops_touch_updated_at();

COMMIT;
