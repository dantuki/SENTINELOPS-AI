BEGIN;

DO $migration$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM documents
        WHERE content_sha256 IS NOT NULL
        GROUP BY project_id, content_sha256
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION
            'Migration aborted: duplicate document content hashes must be reconciled before enabling ingestion idempotency.';
    END IF;
END
$migration$;

CREATE UNIQUE INDEX uq_documents_project_content_sha256
    ON documents (project_id, content_sha256)
    WHERE content_sha256 IS NOT NULL;

COMMIT;
