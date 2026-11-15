BEGIN;

-- QA memory intentionally stores report metadata and evidence references, never
-- downloaded repository bodies or evidence excerpts.
CREATE TABLE IF NOT EXISTS qa_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    title TEXT NOT NULL CHECK (btrim(title) <> '' AND char_length(title) <= 160),
    is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_qa_conversations_id_project UNIQUE (id, project_id)
);

CREATE TABLE IF NOT EXISTS qa_conversation_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL,
    conversation_id UUID NOT NULL,
    author_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    body TEXT NOT NULL CHECK (btrim(body) <> '' AND char_length(body) <= 8_000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_qa_messages_conversation_project
        FOREIGN KEY (conversation_id, project_id)
        REFERENCES qa_conversations(id, project_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS qa_analysis_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL,
    conversation_id UUID NOT NULL,
    source_id UUID REFERENCES project_sources(id) ON DELETE SET NULL,
    analysis_id TEXT NOT NULL CHECK (analysis_id ~ '^qa-[0-9a-f]{24}$'),
    repository_url TEXT NOT NULL CHECK (btrim(repository_url) <> ''),
    revision TEXT NOT NULL CHECK (btrim(revision) <> ''),
    status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'cancelled')),
    report_summary JSONB NOT NULL CHECK (jsonb_typeof(report_summary) = 'object'),
    inventory JSONB NOT NULL CHECK (jsonb_typeof(inventory) = 'object'),
    failure_code TEXT,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_qa_analysis_runs_id_project UNIQUE (id, project_id),
    CONSTRAINT uq_qa_analysis_identity_revision UNIQUE (project_id, analysis_id, revision),
    CONSTRAINT fk_qa_runs_conversation_project
        FOREIGN KEY (conversation_id, project_id)
        REFERENCES qa_conversations(id, project_id) ON DELETE RESTRICT,
    CONSTRAINT fk_qa_runs_source_project
        FOREIGN KEY (source_id, project_id)
        REFERENCES project_sources(id, project_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS qa_analysis_findings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL,
    analysis_run_id UUID NOT NULL,
    finding_id TEXT NOT NULL CHECK (finding_id ~ '^qa-[0-9a-f]{20}$'),
    rule_id TEXT NOT NULL CHECK (btrim(rule_id) <> ''),
    rule_version TEXT NOT NULL CHECK (btrim(rule_version) <> ''),
    category TEXT NOT NULL CHECK (category IN ('configuration', 'quality', 'security', 'testing')),
    importance TEXT NOT NULL CHECK (importance IN ('info', 'warning', 'high')),
    title TEXT NOT NULL CHECK (btrim(title) <> ''),
    description TEXT NOT NULL CHECK (btrim(description) <> ''),
    recommendation TEXT NOT NULL CHECK (btrim(recommendation) <> ''),
    evidence_path TEXT NOT NULL CHECK (btrim(evidence_path) <> ''),
    evidence_start_line INTEGER NOT NULL CHECK (evidence_start_line > 0),
    evidence_end_line INTEGER NOT NULL CHECK (evidence_end_line >= evidence_start_line),
    evidence_content_sha256 TEXT NOT NULL CHECK (evidence_content_sha256 ~ '^[0-9a-f]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_qa_findings_run_finding UNIQUE (analysis_run_id, finding_id),
    CONSTRAINT fk_qa_findings_run_project
        FOREIGN KEY (analysis_run_id, project_id)
        REFERENCES qa_analysis_runs(id, project_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_qa_conversations_project_activity
    ON qa_conversations (project_id, is_pinned DESC, last_message_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_qa_messages_conversation_created
    ON qa_conversation_messages (conversation_id, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_qa_runs_conversation_completed
    ON qa_analysis_runs (conversation_id, completed_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_qa_findings_run_importance
    ON qa_analysis_findings (analysis_run_id, importance DESC, id ASC);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'trg_qa_conversations_updated_at'
          AND tgrelid = to_regclass('public.qa_conversations')
    ) THEN
        CREATE TRIGGER trg_qa_conversations_updated_at
            BEFORE UPDATE ON qa_conversations
            FOR EACH ROW EXECUTE FUNCTION sentinelops_touch_updated_at();
    END IF;
END;
$$;

COMMIT;
