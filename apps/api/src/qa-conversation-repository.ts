import type { Pool, PoolClient } from "pg";

import type { QaAnalysisReport, QaFinding } from "./qa-analysis.js";

export interface QaConversationRecord {
  id: string;
  projectId: string;
  title: string;
  isPinned: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date;
}

export interface QaConversationMessageRecord {
  id: string;
  conversationId: string;
  projectId: string;
  authorUserId: string | null;
  role: "user" | "assistant" | "system";
  body: string;
  createdAt: Date;
}

export interface QaAnalysisRunRecord {
  id: string;
  projectId: string;
  conversationId: string;
  analysisId: string;
  repositoryUrl: string;
  revision: string;
  status: "completed";
  completedAt: Date;
}

/**
 * The durable portion of a finding. Evidence excerpts and repository bodies are
 * deliberately omitted: only their location and content identity are retained.
 */
export interface QaPersistedFindingRecord {
  id: string;
  ruleId: string;
  ruleVersion: string;
  category: QaFinding["category"];
  importance: QaFinding["importance"];
  title: string;
  description: string;
  recommendation: string;
  evidence: Pick<QaFinding["evidence"], "filePath" | "startLine" | "endLine" | "contentSha256">;
}

export interface QaPersistedAnalysisRunRecord extends QaAnalysisRunRecord {
  reportSummary: {
    rulesetVersion: string;
    detectedStack: string[];
    inspectedFileCount: number;
    findingCount: number;
    limitations: string[];
    testExecution: QaAnalysisReport["testExecution"];
  };
  inventory: QaAnalysisReport["inventory"];
  findings: QaPersistedFindingRecord[];
}

const CONVERSATION_COLUMNS = `
  id AS "id", project_id AS "projectId", title AS "title", is_pinned AS "isPinned",
  created_at AS "createdAt", updated_at AS "updatedAt", last_message_at AS "lastMessageAt"
`;
const MESSAGE_COLUMNS = `
  id AS "id", conversation_id AS "conversationId", project_id AS "projectId",
  author_user_id AS "authorUserId", role AS "role", body AS "body", created_at AS "createdAt"
`;
const RUN_COLUMNS = `
  id AS "id", project_id AS "projectId", conversation_id AS "conversationId",
  analysis_id AS "analysisId", repository_url AS "repositoryUrl", revision AS "revision",
  status AS "status", completed_at AS "completedAt"
`;
const QUALIFIED_RUN_COLUMNS = `
  qa_analysis_runs.id AS "id", qa_analysis_runs.project_id AS "projectId",
  qa_analysis_runs.conversation_id AS "conversationId",
  qa_analysis_runs.analysis_id AS "analysisId",
  qa_analysis_runs.repository_url AS "repositoryUrl",
  qa_analysis_runs.revision AS "revision", qa_analysis_runs.status AS "status",
  qa_analysis_runs.completed_at AS "completedAt"
`;

function safeReportSummary(report: QaAnalysisReport): Record<string, unknown> {
  return {
    rulesetVersion: report.rulesetVersion,
    detectedStack: report.detectedStack,
    inspectedFileCount: report.inspectedFiles.length,
    findingCount: report.findings.length,
    limitations: report.limitations,
    testExecution: report.testExecution,
  };
}

function findingValues(finding: QaFinding): readonly unknown[] {
  return [
    finding.id,
    finding.ruleId,
    finding.ruleVersion,
    finding.category,
    finding.importance,
    finding.title,
    finding.description,
    finding.recommendation,
    finding.evidence.filePath,
    finding.evidence.startLine,
    finding.evidence.endLine,
    finding.evidence.contentSha256,
  ];
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

/** PostgreSQL persistence for QA metadata; repository bodies and excerpts are never stored. */
export class QaConversationRepository {
  constructor(private readonly pool: Pool) {}

  async listConversations(projectId: string): Promise<QaConversationRecord[]> {
    const result = await this.pool.query<QaConversationRecord>(`
      SELECT ${CONVERSATION_COLUMNS}
      FROM qa_conversations
      WHERE project_id = $1::uuid
      ORDER BY is_pinned DESC, last_message_at DESC, id DESC
    `, [projectId]);
    return result.rows;
  }

  async createConversation(projectId: string, userId: string, title: string): Promise<QaConversationRecord | null> {
    const result = await this.pool.query<QaConversationRecord>(`
      INSERT INTO qa_conversations (project_id, created_by_user_id, title)
      SELECT $1::uuid, $2::uuid, $3
      WHERE EXISTS (SELECT 1 FROM projects WHERE id = $1::uuid)
      RETURNING ${CONVERSATION_COLUMNS}
    `, [projectId, userId, title]);
    return result.rows[0] ?? null;
  }

  async getConversation(projectId: string, conversationId: string): Promise<QaConversationRecord | null> {
    const result = await this.pool.query<QaConversationRecord>(`
      SELECT ${CONVERSATION_COLUMNS}
      FROM qa_conversations
      WHERE id = $1::uuid AND project_id = $2::uuid
    `, [conversationId, projectId]);
    return result.rows[0] ?? null;
  }

  async setPinned(projectId: string, conversationId: string, isPinned: boolean): Promise<QaConversationRecord | null> {
    const result = await this.pool.query<QaConversationRecord>(`
      UPDATE qa_conversations
      SET is_pinned = $3
      WHERE id = $1::uuid AND project_id = $2::uuid
      RETURNING ${CONVERSATION_COLUMNS}
    `, [conversationId, projectId, isPinned]);
    return result.rows[0] ?? null;
  }

  async listMessages(projectId: string, conversationId: string): Promise<QaConversationMessageRecord[] | null> {
    const exists = await this.getConversation(projectId, conversationId);
    if (!exists) return null;
    const result = await this.pool.query<QaConversationMessageRecord>(`
      SELECT ${MESSAGE_COLUMNS}
      FROM qa_conversation_messages
      WHERE project_id = $1::uuid AND conversation_id = $2::uuid
      ORDER BY created_at ASC, id ASC
    `, [projectId, conversationId]);
    return result.rows;
  }

  /**
   * Returns only report fields that migration 009 durably stores. This is kept
   * separate from the live import result so callers cannot mistake a historical
   * reference for a retained evidence excerpt.
   */
  async listCompletedAnalyses(
    projectId: string,
    conversationId: string,
  ): Promise<QaPersistedAnalysisRunRecord[]> {
    const result = await this.pool.query<QaPersistedAnalysisRunRecord>(`
      SELECT
        ${QUALIFIED_RUN_COLUMNS},
        qa_analysis_runs.report_summary AS "reportSummary",
        qa_analysis_runs.inventory AS "inventory",
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'id', qa_analysis_findings.id,
              'ruleId', qa_analysis_findings.rule_id,
              'ruleVersion', qa_analysis_findings.rule_version,
              'category', qa_analysis_findings.category,
              'importance', qa_analysis_findings.importance,
              'title', qa_analysis_findings.title,
              'description', qa_analysis_findings.description,
              'recommendation', qa_analysis_findings.recommendation,
              'evidence', jsonb_build_object(
                'filePath', qa_analysis_findings.evidence_path,
                'startLine', qa_analysis_findings.evidence_start_line,
                'endLine', qa_analysis_findings.evidence_end_line,
                'contentSha256', qa_analysis_findings.evidence_content_sha256
              )
            )
            ORDER BY
              CASE qa_analysis_findings.importance
                WHEN 'high' THEN 0
                WHEN 'warning' THEN 1
                ELSE 2
              END,
              qa_analysis_findings.id
          ) FILTER (WHERE qa_analysis_findings.id IS NOT NULL),
          '[]'::jsonb
        ) AS "findings"
      FROM qa_analysis_runs
      LEFT JOIN qa_analysis_findings
        ON qa_analysis_findings.analysis_run_id = qa_analysis_runs.id
        AND qa_analysis_findings.project_id = qa_analysis_runs.project_id
      WHERE qa_analysis_runs.project_id = $1::uuid
        AND qa_analysis_runs.conversation_id = $2::uuid
        AND qa_analysis_runs.status = 'completed'
      GROUP BY qa_analysis_runs.id
      ORDER BY qa_analysis_runs.completed_at DESC, qa_analysis_runs.id DESC
    `, [projectId, conversationId]);
    return result.rows;
  }

  async addMessage(
    projectId: string,
    conversationId: string,
    authorUserId: string | null,
    role: QaConversationMessageRecord["role"],
    body: string,
  ): Promise<QaConversationMessageRecord | null> {
    return withTransaction(this.pool, async (client) => {
      const message = await client.query<QaConversationMessageRecord>(`
        INSERT INTO qa_conversation_messages (project_id, conversation_id, author_user_id, role, body)
        SELECT $1::uuid, $2::uuid, $3::uuid, $4, $5
        WHERE EXISTS (
          SELECT 1 FROM qa_conversations
          WHERE id = $2::uuid AND project_id = $1::uuid
        )
        RETURNING ${MESSAGE_COLUMNS}
      `, [projectId, conversationId, authorUserId, role, body]);
      const record = message.rows[0] ?? null;
      if (!record) return null;
      await client.query(`
        UPDATE qa_conversations SET last_message_at = $3
        WHERE id = $1::uuid AND project_id = $2::uuid
      `, [conversationId, projectId, record.createdAt]);
      return record;
    });
  }

  async recordCompletedAnalysis(input: {
    projectId: string;
    conversationId: string;
    sourceId: string;
    repositoryUrl: string;
    revision: string;
    report: QaAnalysisReport;
  }): Promise<QaAnalysisRunRecord | null> {
    return withTransaction(this.pool, async (client) => {
      const run = await client.query<QaAnalysisRunRecord>(`
        INSERT INTO qa_analysis_runs (
          project_id, conversation_id, source_id, analysis_id, repository_url,
          revision, status, report_summary, inventory
        )
        SELECT $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, 'completed', $7::jsonb, $8::jsonb
        WHERE EXISTS (
          SELECT 1 FROM qa_conversations
          WHERE id = $2::uuid AND project_id = $1::uuid
        )
        ON CONFLICT (project_id, analysis_id, revision) DO UPDATE
        SET report_summary = EXCLUDED.report_summary,
            inventory = EXCLUDED.inventory,
            completed_at = qa_analysis_runs.completed_at
        RETURNING ${RUN_COLUMNS}
      `, [
        input.projectId,
        input.conversationId,
        input.sourceId,
        input.report.analysisId,
        input.repositoryUrl,
        input.revision,
        JSON.stringify(safeReportSummary(input.report)),
        JSON.stringify(input.report.inventory),
      ]);
      const record = run.rows[0] ?? null;
      if (!record) return null;
      for (const finding of input.report.findings) {
        await client.query(`
          INSERT INTO qa_analysis_findings (
            project_id, analysis_run_id, finding_id, rule_id, rule_version,
            category, importance, title, description, recommendation,
            evidence_path, evidence_start_line, evidence_end_line, evidence_content_sha256
          ) VALUES (
            $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
          ) ON CONFLICT (analysis_run_id, finding_id) DO NOTHING
        `, [input.projectId, record.id, ...findingValues(finding)]);
      }
      await client.query(`
        UPDATE qa_conversations SET last_message_at = now()
        WHERE id = $1::uuid AND project_id = $2::uuid
      `, [input.conversationId, input.projectId]);
      return record;
    });
  }
}
