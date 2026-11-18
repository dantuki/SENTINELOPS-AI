BEGIN;

-- Version 009 treated an analysis identity as globally unique within a project.
-- A durable job's idempotency key now suppresses accidental retries, while a
-- deliberate request must be able to retain its own conversation and analysis
-- history even when it targets the same repository revision.  This changes
-- only the constraint; it does not discard existing rows or evidence.
ALTER TABLE qa_analysis_runs
    DROP CONSTRAINT IF EXISTS uq_qa_analysis_identity_revision;

-- Job state is deliberately metadata-only. Imported repository bodies and
-- evidence excerpts remain transient and are never stored in this queue.
CREATE TABLE IF NOT EXISTS qa_analysis_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    conversation_id UUID,
    analysis_run_id UUID,
    idempotency_key UUID NOT NULL,
    repository_url TEXT NOT NULL CHECK (btrim(repository_url) <> '' AND char_length(repository_url) <= 2048),
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
    stage TEXT NOT NULL CHECK (stage IN (
        'queued', 'validating_repository', 'fetching_repository_metadata',
        'listing_repository_files', 'selecting_analysis_files', 'reading_manifest',
        'reading_source', 'reading_tests', 'reading_documentation', 'analyzing_files',
        'verifying_findings', 'preparing_report', 'completed', 'failed'
    )),
    next_sequence INTEGER NOT NULL DEFAULT 0 CHECK (next_sequence >= 0),
    error_code TEXT CHECK (error_code IS NULL OR char_length(error_code) <= 80),
    error_message TEXT CHECK (error_message IS NULL OR char_length(error_message) <= 300),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_qa_analysis_jobs_id_project UNIQUE (id, project_id),
    CONSTRAINT uq_qa_analysis_jobs_idempotency UNIQUE (project_id, created_by_user_id, idempotency_key),
    CONSTRAINT fk_qa_jobs_conversation_project
        FOREIGN KEY (conversation_id, project_id)
        REFERENCES qa_conversations(id, project_id) ON DELETE RESTRICT,
    CONSTRAINT fk_qa_jobs_run_project
        FOREIGN KEY (analysis_run_id, project_id)
        REFERENCES qa_analysis_runs(id, project_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS qa_analysis_job_events (
    job_id UUID NOT NULL,
    project_id UUID NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    stage TEXT NOT NULL CHECK (stage IN (
        'queued', 'validating_repository', 'fetching_repository_metadata',
        'listing_repository_files', 'selecting_analysis_files', 'reading_manifest',
        'reading_source', 'reading_tests', 'reading_documentation', 'analyzing_files',
        'verifying_findings', 'preparing_report', 'completed', 'failed'
    )),
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
    message TEXT NOT NULL CHECK (btrim(message) <> '' AND char_length(message) <= 300),
    file_path TEXT CHECK (file_path IS NULL OR (char_length(file_path) <= 512 AND file_path !~ '[\\\\]')),
    processed_files INTEGER CHECK (processed_files IS NULL OR processed_files >= 0),
    selected_files INTEGER CHECK (selected_files IS NULL OR selected_files >= 0),
    error_code TEXT CHECK (error_code IS NULL OR char_length(error_code) <= 80),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (job_id, sequence),
    CONSTRAINT fk_qa_job_events_job_project
        FOREIGN KEY (job_id, project_id)
        REFERENCES qa_analysis_jobs(id, project_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_qa_analysis_jobs_project_activity
    ON qa_analysis_jobs (project_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_qa_analysis_jobs_status
    ON qa_analysis_jobs (status, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_qa_analysis_job_events_job_sequence
    ON qa_analysis_job_events (job_id, sequence ASC);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'trg_qa_analysis_jobs_updated_at'
          AND tgrelid = to_regclass('public.qa_analysis_jobs')
    ) THEN
        CREATE TRIGGER trg_qa_analysis_jobs_updated_at
            BEFORE UPDATE ON qa_analysis_jobs
            FOR EACH ROW EXECUTE FUNCTION sentinelops_touch_updated_at();
    END IF;
END;
$$;

COMMIT;
