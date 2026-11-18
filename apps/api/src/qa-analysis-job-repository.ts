import type { Pool, PoolClient } from "pg";

export const QA_ANALYSIS_JOB_STAGES = [
  "queued",
  "validating_repository",
  "fetching_repository_metadata",
  "listing_repository_files",
  "selecting_analysis_files",
  "reading_manifest",
  "reading_source",
  "reading_tests",
  "reading_documentation",
  "analyzing_files",
  "verifying_findings",
  "preparing_report",
  "completed",
  "failed",
] as const;

export type QaAnalysisJobStage = (typeof QA_ANALYSIS_JOB_STAGES)[number];
export type QaAnalysisJobStatus = "queued" | "running" | "completed" | "failed";

export interface QaAnalysisJobRecord {
  id: string;
  projectId: string;
  createdByUserId: string;
  conversationId: string | null;
  analysisRunId: string | null;
  idempotencyKey: string;
  repositoryUrl: string;
  status: QaAnalysisJobStatus;
  stage: QaAnalysisJobStage;
  nextSequence: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
}

export interface QaAnalysisJobEventRecord {
  jobId: string;
  projectId: string;
  sequence: number;
  stage: QaAnalysisJobStage;
  status: QaAnalysisJobStatus;
  message: string;
  filePath: string | null;
  processedFiles: number | null;
  selectedFiles: number | null;
  errorCode: string | null;
  createdAt: Date;
}

export interface QaAnalysisJobProgress {
  stage: Exclude<QaAnalysisJobStage, "queued" | "completed" | "failed">;
  message: string;
  filePath?: string;
  processedFiles?: number;
  selectedFiles?: number;
}

const JOB_COLUMNS = `
  id AS "id", project_id AS "projectId", created_by_user_id AS "createdByUserId",
  conversation_id AS "conversationId", analysis_run_id AS "analysisRunId",
  idempotency_key AS "idempotencyKey", repository_url AS "repositoryUrl",
  status AS "status", stage AS "stage", next_sequence AS "nextSequence",
  error_code AS "errorCode", error_message AS "errorMessage", created_at AS "createdAt",
  started_at AS "startedAt", completed_at AS "completedAt", updated_at AS "updatedAt"
`;

const EVENT_COLUMNS = `
  job_id AS "jobId", project_id AS "projectId", sequence AS "sequence",
  stage AS "stage", status AS "status", message AS "message", file_path AS "filePath",
  processed_files AS "processedFiles", selected_files AS "selectedFiles",
  error_code AS "errorCode", created_at AS "createdAt"
`;

function toDisplayMessage(value: string): string {
  return value.trim().slice(0, 300);
}

function safeFilePath(value: string | undefined): string | null {
  if (!value || value.length > 512 || value.includes("\\")) return null;
  return value;
}

async function withTransaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Durable state for the bounded public-repository QA pipeline. It intentionally
 * stores only safe event metadata, never imported repository bodies or prompts.
 */
export class QaAnalysisJobRepository {
  constructor(private readonly pool: Pool) {}

  async createOrGet(input: {
    projectId: string;
    userId: string;
    conversationId?: string;
    repositoryUrl: string;
    idempotencyKey: string;
  }): Promise<{ job: QaAnalysisJobRecord; created: boolean } | null> {
    return withTransaction(this.pool, async (client) => {
      const inserted = await client.query<QaAnalysisJobRecord>(`
        INSERT INTO qa_analysis_jobs (
          project_id, created_by_user_id, conversation_id, repository_url,
          idempotency_key, status, stage
        )
        SELECT $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, 'queued', 'queued'
        WHERE EXISTS (SELECT 1 FROM projects WHERE id = $1::uuid)
        ON CONFLICT (project_id, created_by_user_id, idempotency_key) DO NOTHING
        RETURNING ${JOB_COLUMNS}
      `, [
        input.projectId,
        input.userId,
        input.conversationId ?? null,
        input.repositoryUrl,
        input.idempotencyKey,
      ]);
      const job = inserted.rows[0];
      if (job) {
        await client.query(`
          INSERT INTO qa_analysis_job_events (
            job_id, project_id, sequence, stage, status, message
          ) VALUES ($1::uuid, $2::uuid, 1, 'queued', 'queued', 'El análisis está en cola.')
        `, [job.id, input.projectId]);
        await client.query(`
          UPDATE qa_analysis_jobs SET next_sequence = 1 WHERE id = $1::uuid AND project_id = $2::uuid
        `, [job.id, input.projectId]);
        return { job: { ...job, nextSequence: 1 }, created: true };
      }

      const existing = await client.query<QaAnalysisJobRecord>(`
        SELECT ${JOB_COLUMNS}
        FROM qa_analysis_jobs
        WHERE project_id = $1::uuid
          AND created_by_user_id = $2::uuid
          AND idempotency_key = $3::uuid
      `, [input.projectId, input.userId, input.idempotencyKey]);
      const existingJob = existing.rows[0] ?? null;
      return existingJob ? { job: existingJob, created: false } : null;
    });
  }

  async get(projectId: string, jobId: string): Promise<QaAnalysisJobRecord | null> {
    const result = await this.pool.query<QaAnalysisJobRecord>(`
      SELECT ${JOB_COLUMNS}
      FROM qa_analysis_jobs
      WHERE id = $1::uuid AND project_id = $2::uuid
    `, [jobId, projectId]);
    return result.rows[0] ?? null;
  }

  async listEvents(projectId: string, jobId: string, afterSequence = 0): Promise<QaAnalysisJobEventRecord[] | null> {
    const exists = await this.get(projectId, jobId);
    if (!exists) return null;
    const result = await this.pool.query<QaAnalysisJobEventRecord>(`
      SELECT ${EVENT_COLUMNS}
      FROM qa_analysis_job_events
      WHERE job_id = $1::uuid AND project_id = $2::uuid AND sequence > $3
      ORDER BY sequence ASC
      LIMIT 100
    `, [jobId, projectId, afterSequence]);
    return result.rows;
  }

  async start(projectId: string, jobId: string): Promise<QaAnalysisJobRecord | null> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<QaAnalysisJobRecord>(`
        UPDATE qa_analysis_jobs
        SET status = 'running', stage = 'validating_repository',
            started_at = COALESCE(started_at, now()), next_sequence = next_sequence + 1
        WHERE id = $1::uuid AND project_id = $2::uuid AND status = 'queued'
        RETURNING ${JOB_COLUMNS}
      `, [jobId, projectId]);
      const job = result.rows[0] ?? null;
      if (!job) return null;
      await client.query(`
        INSERT INTO qa_analysis_job_events (
          job_id, project_id, sequence, stage, status, message
        ) VALUES ($1::uuid, $2::uuid, $3, 'validating_repository', 'running', 'Validando el repositorio solicitado.')
      `, [job.id, projectId, job.nextSequence]);
      return job;
    });
  }

  async appendProgress(projectId: string, jobId: string, progress: QaAnalysisJobProgress): Promise<QaAnalysisJobRecord | null> {
    const message = toDisplayMessage(progress.message);
    if (!message) throw new Error("QA job progress requires a display message");
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<QaAnalysisJobRecord>(`
        UPDATE qa_analysis_jobs
        SET stage = $3, next_sequence = next_sequence + 1
        WHERE id = $1::uuid AND project_id = $2::uuid AND status = 'running'
        RETURNING ${JOB_COLUMNS}
      `, [jobId, projectId, progress.stage]);
      const job = result.rows[0] ?? null;
      if (!job) return null;
      await client.query(`
        INSERT INTO qa_analysis_job_events (
          job_id, project_id, sequence, stage, status, message,
          file_path, processed_files, selected_files
        ) VALUES ($1::uuid, $2::uuid, $3, $4, 'running', $5, $6, $7, $8)
      `, [
        jobId,
        projectId,
        job.nextSequence,
        progress.stage,
        message,
        safeFilePath(progress.filePath),
        progress.processedFiles ?? null,
        progress.selectedFiles ?? null,
      ]);
      return job;
    });
  }

  async complete(input: {
    projectId: string;
    jobId: string;
    conversationId: string;
    analysisRunId: string;
  }): Promise<QaAnalysisJobRecord | null> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<QaAnalysisJobRecord>(`
        UPDATE qa_analysis_jobs
        SET status = 'completed', stage = 'completed', conversation_id = $3::uuid,
            analysis_run_id = $4::uuid, completed_at = now(), next_sequence = next_sequence + 1
        WHERE id = $1::uuid AND project_id = $2::uuid AND status = 'running'
        RETURNING ${JOB_COLUMNS}
      `, [input.jobId, input.projectId, input.conversationId, input.analysisRunId]);
      const job = result.rows[0] ?? null;
      if (!job) return null;
      await client.query(`
        INSERT INTO qa_analysis_job_events (
          job_id, project_id, sequence, stage, status, message
        ) VALUES ($1::uuid, $2::uuid, $3, 'completed', 'completed', 'El informe QA está listo.')
      `, [input.jobId, input.projectId, job.nextSequence]);
      return job;
    });
  }

  async fail(input: {
    projectId: string;
    jobId: string;
    code: string;
    message: string;
  }): Promise<QaAnalysisJobRecord | null> {
    const message = toDisplayMessage(input.message);
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<QaAnalysisJobRecord>(`
        UPDATE qa_analysis_jobs
        SET status = 'failed', stage = 'failed', error_code = $3, error_message = $4,
            completed_at = now(), next_sequence = next_sequence + 1
        WHERE id = $1::uuid AND project_id = $2::uuid AND status IN ('queued', 'running')
        RETURNING ${JOB_COLUMNS}
      `, [input.jobId, input.projectId, input.code.slice(0, 80), message]);
      const job = result.rows[0] ?? null;
      if (!job) return null;
      await client.query(`
        INSERT INTO qa_analysis_job_events (
          job_id, project_id, sequence, stage, status, message, error_code
        ) VALUES ($1::uuid, $2::uuid, $3, 'failed', 'failed', $4, $5)
      `, [input.jobId, input.projectId, job.nextSequence, message, input.code.slice(0, 80)]);
      return job;
    });
  }

  /** A process restart must not be represented as a completed analysis. */
  async failInterruptedJobs(): Promise<number> {
    return withTransaction(this.pool, async (client) => {
      const pending = await client.query<Pick<QaAnalysisJobRecord, "id" | "projectId" | "nextSequence">>(`
        SELECT id AS "id", project_id AS "projectId", next_sequence AS "nextSequence"
        FROM qa_analysis_jobs
        WHERE status IN ('queued', 'running')
        FOR UPDATE
      `);
      for (const job of pending.rows) {
        const sequence = job.nextSequence + 1;
        await client.query(`
          UPDATE qa_analysis_jobs
          SET status = 'failed', stage = 'failed', error_code = 'process_interrupted',
              error_message = 'El análisis se interrumpió antes de completarse. Puede iniciarse uno nuevo.',
              completed_at = now(), next_sequence = $3
          WHERE id = $1::uuid AND project_id = $2::uuid
        `, [job.id, job.projectId, sequence]);
        await client.query(`
          INSERT INTO qa_analysis_job_events (
            job_id, project_id, sequence, stage, status, message, error_code
          ) VALUES (
            $1::uuid, $2::uuid, $3, 'failed', 'failed',
            'El análisis se interrumpió antes de completarse. Puede iniciarse uno nuevo.', 'process_interrupted'
          )
        `, [job.id, job.projectId, sequence]);
      }
      return pending.rows.length;
    });
  }
}
