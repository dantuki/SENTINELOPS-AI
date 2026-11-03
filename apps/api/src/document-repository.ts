
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

export interface IngestionDocumentRecord extends DocumentRecord {
  extractedText: string | null;
}

export interface CreateOrGetDocumentResult {
  document: DocumentRecord;
  created: boolean;
}

export interface IngestionState {
  status: "processing" | "indexed" | "failed";
  attempts?: number;
  startedAt?: string;
  completedAt?: string;
  error?: string | null;
  chunks?: number;
  embeddingModel?: string | null;
}

export interface ClaimDocumentResult {
  document: DocumentRecord;
  claimed: boolean;
}

const DOCUMENT_COLUMNS = `
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
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
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

  async createOrGetForProject(
    projectId: string,
    input: CreateDocumentInput & { contentSha256: string },
  ): Promise<CreateOrGetDocumentResult | null> {
    const inserted = await this.pool.query<DocumentRecord>(
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
        ON CONFLICT (project_id, content_sha256)
          WHERE content_sha256 IS NOT NULL
        DO NOTHING
        RETURNING ${DOCUMENT_COLUMNS}
      `,
      [
        projectId,
        input.sourceId,
        input.sourceDocumentKey ?? null,
        input.title,
        input.mediaType ?? null,
        input.contentSha256,
        input.extractedText ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );

    const created = inserted.rows[0];
    if (created) {
      return { document: created, created: true };
    }

    const existing = await this.pool.query<DocumentRecord>(
      `
        SELECT ${DOCUMENT_COLUMNS}
        FROM documents
        WHERE project_id = $1::uuid
          AND content_sha256 = $2
      `,
      [projectId, input.contentSha256],
    );

    const document = existing.rows[0];
    return document ? { document, created: false } : null;
  }

  async getForIngestion(
    projectId: string,
    documentId: string,
  ): Promise<IngestionDocumentRecord | null> {
    const result = await this.pool.query<IngestionDocumentRecord>(
      `
        SELECT ${DOCUMENT_COLUMNS},
          extracted_text AS "extractedText"
        FROM documents
        WHERE project_id = $1::uuid
          AND id = $2::uuid
      `,
      [projectId, documentId],
    );

    return result.rows[0] ?? null;
  }

  async claimForProcessing(
    projectId: string,
    documentId: string,
  ): Promise<ClaimDocumentResult | null> {
    const client = await this.pool.connect();
    let transactionStarted = false;

    try {
      await client.query("BEGIN");
      transactionStarted = true;

      const selected = await client.query<
        DocumentRecord & { extractedText: string | null }
      >(
        `
          SELECT ${DOCUMENT_COLUMNS},
            extracted_text AS "extractedText"
          FROM documents
          WHERE project_id = $1::uuid
            AND id = $2::uuid
          FOR UPDATE
        `,
        [projectId, documentId],
      );
      const document = selected.rows[0];

      if (!document) {
        await client.query("ROLLBACK");
        transactionStarted = false;
        return null;
      }

      if (
        document.status !== "discovered" &&
        document.status !== "failed"
      ) {
        await client.query("COMMIT");
        transactionStarted = false;
        return { document, claimed: false };
      }

      const metadata = isRecord(document.metadata)
        ? document.metadata
        : {};
      const oldIngestion = isRecord(metadata.ingestion)
        ? metadata.ingestion
        : {};
      const oldAttempts = oldIngestion.attempts;
      const attempts =
        typeof oldAttempts === "number" &&
        Number.isSafeInteger(oldAttempts) &&
        oldAttempts >= 0
          ? oldAttempts + 1
          : 1;
      const startedAt = new Date().toISOString();
      const nextMetadata = {
        ...metadata,
        ingestion: {
          ...oldIngestion,
          status: "processing",
          attempts,
          startedAt,
          completedAt: null,
          error: null,
        },
      };

      const updated = await client.query<DocumentRecord>(
        `
          UPDATE documents
          SET status = 'processing', metadata = $3::jsonb
          WHERE project_id = $1::uuid AND id = $2::uuid
          RETURNING ${DOCUMENT_COLUMNS}
        `,
        [projectId, documentId, JSON.stringify(nextMetadata)],
      );

      await client.query("COMMIT");
      transactionStarted = false;

      const claimedDocument = updated.rows[0];
      return claimedDocument
        ? { document: claimedDocument, claimed: true }
        : null;
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

  async setIngestionState(
    projectId: string,
    documentId: string,
    state: IngestionState,
  ): Promise<boolean> {
    const selected = await this.pool.query<{
      metadata: Record<string, unknown>;
    }>(
      `
        SELECT metadata
        FROM documents
        WHERE project_id = $1::uuid AND id = $2::uuid
      `,
      [projectId, documentId],
    );
    const document = selected.rows[0];

    if (!document) {
      return false;
    }

    const metadata = isRecord(document.metadata)
      ? document.metadata
      : {};
    const oldIngestion = isRecord(metadata.ingestion)
      ? metadata.ingestion
      : {};
    const nextMetadata = {
      ...metadata,
      ingestion: { ...oldIngestion, ...state },
    };
    const result = await this.pool.query(
      `
        UPDATE documents
        SET status = $3, metadata = $4::jsonb
        WHERE project_id = $1::uuid AND id = $2::uuid
        RETURNING id
      `,
      [
        projectId,
        documentId,
        state.status,
        JSON.stringify(nextMetadata),
      ],
    );

    return result.rows.length === 1;
  }
}
