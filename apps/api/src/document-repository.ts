
import type { Pool } from "pg";

export type DocumentStatus =
  | "discovered"
  | "processing"
  | "indexed"
  | "failed"
  | "archived";

export interface DocumentRecord {
  id: string;
  projectId: string;
  sourceId: string;
  sourceDocumentKey: string | null;
  title: string;
  mediaType: string | null;
  contentSha256: string | null;
  status: DocumentStatus;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateDocumentInput {
  sourceId: string;
  title: string;
  sourceDocumentKey?: string | null;
  mediaType?: string | null;
  contentSha256?: string | null;
  extractedText?: string | null;
  metadata?: Record<string, unknown>;
}

export class DocumentRepository {
  constructor(private readonly pool: Pool) {}

  async listForProject(
    projectId: string,
  ): Promise<DocumentRecord[] | null> {
    const projectResult = await this.pool.query(
      "SELECT 1 FROM projects WHERE id = $1::uuid",
      [projectId],
    );

    if (projectResult.rows.length === 0) {
      return null;
    }

    const result = await this.pool.query<DocumentRecord>(
      `
        SELECT
          id,
          project_id AS "projectId",
          source_id AS "sourceId",
          source_document_key AS "sourceDocumentKey",
          title,
          media_type AS "mediaType",
          content_sha256 AS "contentSha256",
          status,
          metadata,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM documents
        WHERE project_id = $1::uuid
        ORDER BY created_at DESC, id ASC
      `,
      [projectId],
    );

    return result.rows;
  }

  async createForProject(
    projectId: string,
    input: CreateDocumentInput,
  ): Promise<DocumentRecord | null> {
    const result = await this.pool.query<DocumentRecord>(
      `
        INSERT INTO documents (
          project_id,
          source_id,
          source_document_key,
          title,
          media_type,
          content_sha256,
          extracted_text,
          metadata
        )
        SELECT
          $1::uuid,
          source.id,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8::jsonb
        FROM project_sources AS source
        WHERE source.id = $2::uuid
          AND source.project_id = $1::uuid
        RETURNING
          id,
          project_id AS "projectId",
          source_id AS "sourceId",
          source_document_key AS "sourceDocumentKey",
          title,
          media_type AS "mediaType",
          content_sha256 AS "contentSha256",
          status,
          metadata,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
      [
        projectId,
        input.sourceId,
        input.sourceDocumentKey ?? null,
        input.title,
        input.mediaType ?? null,
        input.contentSha256 ?? null,
        input.extractedText ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );

    return result.rows[0] ?? null;
  }
}
