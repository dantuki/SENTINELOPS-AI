
import type { Pool } from "pg";

export interface DocumentChunkRecord {
  id: string;
  projectId: string;
  documentId: string;
  ordinal: number;
  content: string;
  tokenCount: number | null;
  startOffset: number | null;
  endOffset: number | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface CreateDocumentChunkInput {
  ordinal: number;
  content: string;
  tokenCount?: number | null;
  startOffset?: number | null;
  endOffset?: number | null;
  metadata?: Record<string, unknown>;
}

export class DocumentChunkRepository {
  constructor(private readonly pool: Pool) {}

  async listForDocument(
    projectId: string,
    documentId: string,
  ): Promise<DocumentChunkRecord[] | null> {
    const documentResult = await this.pool.query(
      `
        SELECT 1
        FROM documents
        WHERE id = $1::uuid
          AND project_id = $2::uuid
      `,
      [documentId, projectId],
    );

    if (documentResult.rows.length === 0) {
      return null;
    }

    const result = await this.pool.query<DocumentChunkRecord>(
      `
        SELECT
          id,
          project_id AS "projectId",
          document_id AS "documentId",
          ordinal,
          content,
          token_count AS "tokenCount",
          start_offset AS "startOffset",
          end_offset AS "endOffset",
          metadata,
          created_at AS "createdAt"
        FROM document_chunks
        WHERE project_id = $1::uuid
          AND document_id = $2::uuid
        ORDER BY ordinal ASC
      `,
      [projectId, documentId],
    );

    return result.rows;
  }

  async createForDocument(
    projectId: string,
    documentId: string,
    input: CreateDocumentChunkInput,
  ): Promise<DocumentChunkRecord | null> {
    const result = await this.pool.query<DocumentChunkRecord>(
      `
        INSERT INTO document_chunks (
          project_id,
          document_id,
          ordinal,
          content,
          token_count,
          start_offset,
          end_offset,
          metadata
        )
        SELECT
          $1::uuid,
          document.id,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8::jsonb
        FROM documents AS document
        WHERE document.id = $2::uuid
          AND document.project_id = $1::uuid
        RETURNING
          id,
          project_id AS "projectId",
          document_id AS "documentId",
          ordinal,
          content,
          token_count AS "tokenCount",
          start_offset AS "startOffset",
          end_offset AS "endOffset",
          metadata,
          created_at AS "createdAt"
      `,
      [
        projectId,
        documentId,
        input.ordinal,
        input.content,
        input.tokenCount ?? null,
        input.startOffset ?? null,
        input.endOffset ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );

    return result.rows[0] ?? null;
  }
}
