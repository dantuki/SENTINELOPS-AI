
import type { Pool } from "pg";

const EMBEDDING_DIMENSIONS = 1536;

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

export interface PendingEmbeddingChunk {
  id: string;
  ordinal: number;
  content: string;
}

export interface ChunkEmbeddingInput {
  id: string;
  embedding: number[];
  model: string;
}

export interface SemanticSearchChunkRecord {
  id: string;
  projectId: string;
  documentId: string;
  ordinal: number;
  content: string;
  score: number;
}

export class EmbeddingWriteConflictError extends Error {
  constructor() {
    super("A chunk was modified before its embedding could be saved.");
    this.name = "EmbeddingWriteConflictError";
  }
}

function toVectorSql(embedding: number[]): string {
  if (
    embedding.length !== EMBEDDING_DIMENSIONS ||
    !embedding.every(Number.isFinite)
  ) {
    throw new TypeError(
      `Embedding must contain ${EMBEDDING_DIMENSIONS} finite numbers.`,
    );
  }

  return `[${embedding.join(",")}]`;
}

export class DocumentChunkRepository {
  constructor(private readonly pool: Pool) {}

  async projectExists(projectId: string): Promise<boolean> {
    const result = await this.pool.query(
      `
        SELECT 1
        FROM projects
        WHERE id = $1::uuid
      `,
      [projectId],
    );

    return result.rows.length > 0;
  }

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

  async listWithoutEmbeddingsForDocument(
    projectId: string,
    documentId: string,
    limit = 32,
  ): Promise<PendingEmbeddingChunk[] | null> {
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

    const result = await this.pool.query<PendingEmbeddingChunk>(
      `
        SELECT id, ordinal, content
        FROM document_chunks
        WHERE project_id = $1::uuid
          AND document_id = $2::uuid
          AND embedding IS NULL
        ORDER BY ordinal ASC
        LIMIT $3
      `,
      [projectId, documentId, limit],
    );

    return result.rows;
  }

  async saveEmbeddingsForDocument(
    projectId: string,
    documentId: string,
    embeddings: ChunkEmbeddingInput[],
  ): Promise<number | null> {
    if (embeddings.length === 0) {
      return 0;
    }

    const client = await this.pool.connect();
    let transactionStarted = false;

    try {
      await client.query("BEGIN");
      transactionStarted = true;

      const documentResult = await client.query(
        `
          SELECT 1
          FROM documents
          WHERE id = $1::uuid
            AND project_id = $2::uuid
        `,
        [documentId, projectId],
      );

      if (documentResult.rows.length === 0) {
        await client.query("ROLLBACK");
        transactionStarted = false;
        return null;
      }

      for (const item of embeddings) {
        if (!item.model.trim()) {
          throw new TypeError("Embedding model must not be empty.");
        }

        const vector = toVectorSql(item.embedding);

        const result = await client.query(
          `
            UPDATE document_chunks
            SET
              embedding = $4::vector,
              embedding_model = $5,
              embedding_updated_at = now()
            WHERE id = $1::uuid
              AND project_id = $2::uuid
              AND document_id = $3::uuid
              AND embedding IS NULL
            RETURNING id
          `,
          [
            item.id,
            projectId,
            documentId,
            vector,
            item.model,
          ],
        );

        if (result.rows.length !== 1) {
          throw new EmbeddingWriteConflictError();
        }
      }

      await client.query("COMMIT");
      transactionStarted = false;

      return embeddings.length;
    } catch (error: unknown) {
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the original error.
        }
      }

      throw error;
    } finally {
      client.release();
    }
  }

  async searchSimilarChunks(
    projectId: string,
    embedding: number[],
    limit = 5,
  ): Promise<SemanticSearchChunkRecord[] | null> {
    const vector = toVectorSql(embedding);

    const projectResult = await this.pool.query(
      `
        SELECT 1
        FROM projects
        WHERE id = $1::uuid
      `,
      [projectId],
    );

    if (projectResult.rows.length === 0) {
      return null;
    }

    const result = await this.pool.query<SemanticSearchChunkRecord>(
      `
        SELECT
          id,
          project_id AS "projectId",
          document_id AS "documentId",
          ordinal,
          content,
          (1 - (embedding <=> $2::vector))::double precision AS score
        FROM document_chunks
        WHERE project_id = $1::uuid
          AND embedding IS NOT NULL
        ORDER BY embedding <=> $2::vector ASC
        LIMIT $3
      `,
      [projectId, vector, limit],
    );

    return result.rows.map((row) => ({
      ...row,
      score: Number(row.score),
    }));
  }
}
