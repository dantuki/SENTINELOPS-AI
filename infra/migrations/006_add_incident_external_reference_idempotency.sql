BEGIN;

DO $migration$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM incidents
        WHERE external_reference IS NOT NULL
        GROUP BY project_id, external_reference
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION
            'Migration aborted: duplicate incident external references must be reconciled before enabling incident idempotency.';
    END IF;
END
$migration$;

CREATE UNIQUE INDEX uq_incidents_project_external_reference
    ON incidents (project_id, external_reference)
    WHERE external_reference IS NOT NULL;

COMMIT;
