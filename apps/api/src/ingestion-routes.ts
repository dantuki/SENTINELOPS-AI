import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";

import {
  requestEmbeddings,
  type EmbeddingClientOptions,
} from "./embedding-client.js";
import {
  ChunkContentConflictError,
  type ChunkEmbeddingInput,
  type DocumentChunkRecord,
  type PendingEmbeddingChunk,
} from "./chunk-repository.js";
import {
  type ClaimDocumentResult,
  type CreateDocumentInput,
  type CreateOrGetDocumentResult,
  type DocumentRecord,
  type IngestionDocumentRecord,
  type IngestionState,
} from "./document-repository.js";
import {
  chunkTechnicalText,
  IngestionInputError,
  type IngestionInputStatusCode,
  MAX_INGESTION_FILE_CHARS,
  validateIngestionFile,
} from "./ingestion-utils.js";
import {
  type CreateProjectSourceInput,
  type EnsureProjectSourceResult,
  type ProjectSourceRecord,
} from "./source-repository.js";
import type {
  CreateIncidentInput,
  IncidentRecord,
} from "./product-repository.js";

const EMBEDDING_BATCH_SIZE = 32;
const DEMO_DATASET_ID = "sentinelops-synthetic-demo-v1";
const DEMO_SOURCE_LOCATOR =
  "dataset://demo-pedidos-api/incident-001";
const DEMO_FILES = [
  {
    path: "incident-001/observed-logs.jsonl",
    name: "observed-logs.jsonl",
  },
  {
    path: "incident-001/retry-dispatcher.synthetic.ts",
    name: "retry-dispatcher.synthetic.ts",
  },
] as const;

interface IngestionSourceStore {
  ensureForProject(
    projectId: string,
    input: CreateProjectSourceInput,
  ): Promise<EnsureProjectSourceResult | null>;
  getForProject(
    projectId: string,
    sourceId: string,
  ): Promise<ProjectSourceRecord | null>;
  activateIfEnabled(projectId: string, sourceId: string): Promise<boolean>;
}

interface IngestionDocumentStore {
  createOrGetForProject(
    projectId: string,
    input: CreateDocumentInput & { contentSha256: string },
  ): Promise<CreateOrGetDocumentResult | null>;
  getForIngestion(
    projectId: string,
    documentId: string,
  ): Promise<IngestionDocumentRecord | null>;
  claimForProcessing(
    projectId: string,
    documentId: string,
  ): Promise<ClaimDocumentResult | null>;
  setIngestionState(
    projectId: string,
    documentId: string,
    state: IngestionState,
  ): Promise<boolean>;
}

interface IngestionChunkStore {
  createOrGetForDocument(
    projectId: string,
    documentId: string,
    input: {
      ordinal: number;
      content: string;
      startOffset: number;
      endOffset: number;
      metadata: Record<string, unknown>;
    },
  ): Promise<{ chunk: DocumentChunkRecord; created: boolean } | null>;
  listWithoutEmbeddingsForDocument(
    projectId: string,
    documentId: string,
    limit?: number,
  ): Promise<PendingEmbeddingChunk[] | null>;
  saveEmbeddingsForDocument(
    projectId: string,
    documentId: string,
    embeddings: ChunkEmbeddingInput[],
  ): Promise<number | null>;
}

interface IngestionIncidentStore {
  ensureIncident(
    projectId: string,
    input: CreateIncidentInput & { externalReference: string },
  ): Promise<{ incident: IncidentRecord; created: boolean } | null>;
}

interface IngestionStores {
  sources?: IngestionSourceStore;
  documents?: IngestionDocumentStore;
  chunks?: IngestionChunkStore;
  incidents?: IngestionIncidentStore;
}

interface IngestionRouteOptions extends EmbeddingClientOptions {
  readDemoFile?: (path: string) => Promise<string>;
}

interface UploadRequest {
  name: string;
  content: string;
}

interface IngestionResult {
  documentId: string;
  name: string;
  status: DocumentRecord["status"];
  deduplicated: boolean;
  chunksCreated: number;
  embeddingsCreated: number;
  model: string | null;
}

interface ApiError {
  error: string;
}

interface PipelineInput {
  content: string;
  name: string;
  sourceDocumentKey: string;
  metadata: Record<string, unknown>;
}

class IngestionPipelineError extends Error {
  constructor(
    message: string,
    readonly statusCode: IngestionStatusCode,
    readonly code: string,
  ) {
    super(message);
    this.name = "IngestionPipelineError";
  }
}

type IngestionStatusCode =
  | IngestionInputStatusCode
  | 404
  | 409
  | 502
  | 503
  | 504;

const apiErrorSchema = {
  type: "object",
  properties: { error: { type: "string" } },
  required: ["error"],
  additionalProperties: false,
} as const;

const uuidSchema = {
  type: "string",
  format: "uuid",
} as const;

const ingestionResultSchema = {
  type: "object",
  properties: {
    documentId: uuidSchema,
    name: { type: "string" },
    status: {
      type: "string",
      enum: ["discovered", "processing", "indexed", "failed", "archived"],
    },
    deduplicated: { type: "boolean" },
    chunksCreated: { type: "integer", minimum: 0 },
    embeddingsCreated: { type: "integer", minimum: 0 },
    model: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
  required: [
    "documentId",
    "name",
    "status",
    "deduplicated",
    "chunksCreated",
    "embeddingsCreated",
    "model",
  ],
  additionalProperties: false,
} as const;

const uploadResponseSchema = {
  type: "object",
  properties: { data: ingestionResultSchema },
  required: ["data"],
  additionalProperties: false,
} as const;

const acceptedUploadResponseSchema = uploadResponseSchema;

const demoResponseSchema = {
  type: "object",
  properties: {
    data: {
      type: "object",
      properties: {
        dataset: { type: "string" },
        files: {
          type: "array",
          items: ingestionResultSchema,
        },
      },
      required: ["dataset", "files"],
      additionalProperties: false,
    },
  },
  required: ["data"],
  additionalProperties: false,
} as const;

const acceptedDemoResponseSchema = demoResponseSchema;

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isUploadRequest(value: unknown): value is UploadRequest {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => ["name", "content"].includes(key)) &&
    typeof value.name === "string" &&
    typeof value.content === "string"
  );
}

function toResult(
  document: DocumentRecord,
  values: {
    name: string;
    deduplicated: boolean;
    chunksCreated?: number;
    embeddingsCreated?: number;
    model?: string | null;
  },
): IngestionResult {
  return {
    documentId: document.id,
    name: values.name,
    status: document.status,
    deduplicated: values.deduplicated,
    chunksCreated: values.chunksCreated ?? 0,
    embeddingsCreated: values.embeddingsCreated ?? 0,
    model: values.model ?? null,
  };
}

function getErrorResponse(error: unknown): {
  statusCode: IngestionStatusCode;
  message: string;
} {
  if (error instanceof IngestionInputError) {
    return { statusCode: error.statusCode, message: error.message };
  }

  if (error instanceof IngestionPipelineError) {
    return { statusCode: error.statusCode, message: error.message };
  }

  if (error instanceof ChunkContentConflictError) {
    return {
      statusCode: 409,
      message: "A chunk ordinal already exists with different content.",
    };
  }

  return {
    statusCode: 503,
    message: "Document ingestion failed. Check service availability and retry.",
  };
}

function readDemoFileFromRepository(path: string): Promise<string> {
  return readFile(
    new URL(`../../../datasets/demo-pedidos-api/${path}`, import.meta.url),
    "utf8",
  );
}

export function registerIngestionRoutes(
  app: FastifyInstance,
  stores: IngestionStores = {},
  options: IngestionRouteOptions = {},
): void {
  async function ingest(
    projectId: string,
    input: PipelineInput,
  ): Promise<IngestionResult> {
    const sources = stores.sources;
    const documents = stores.documents;
    const chunks = stores.chunks;

    if (!sources || !documents || !chunks) {
      throw new IngestionPipelineError(
        "Persistence unavailable",
        503,
        "persistence_unavailable",
      );
    }

    const file = validateIngestionFile(input.name, input.content);
    const contentSha256 = createHash("sha256")
      .update(input.content, "utf8")
      .digest("hex");
    const sourceMetadata = {
      ...(isRecord(input.metadata.sourceMetadata)
        ? input.metadata.sourceMetadata
        : {}),
    };
    const ensuredSource = await sources.ensureForProject(projectId, {
      sourceType:
        input.metadata.sourceType === "log_bundle"
          ? "log_bundle"
          : "file_upload",
      name:
        typeof sourceMetadata.name === "string"
          ? sourceMetadata.name
          : "Uploaded technical files",
      locator:
        typeof sourceMetadata.locator === "string"
          ? sourceMetadata.locator
          : "upload://",
      metadata: isRecord(sourceMetadata.metadata)
        ? sourceMetadata.metadata
        : {},
    });

    if (!ensuredSource) {
      throw new IngestionPipelineError(
        "Project not found",
        404,
        "project_not_found",
      );
    }

    if (ensuredSource.source.status === "disabled") {
      throw new IngestionPipelineError(
        "Disabled sources cannot accept new documents",
        409,
        "source_disabled",
      );
    }

    const documentMetadata: Record<string, unknown> = {
      format: file.extension || "dotfile",
      chunkingStrategy: file.strategy,
      sourceType: ensuredSource.source.sourceType,
      ...(isRecord(input.metadata.documentMetadata)
        ? input.metadata.documentMetadata
        : {}),
    };
    const createdDocument = await documents.createOrGetForProject(projectId, {
      sourceId: ensuredSource.source.id,
      sourceDocumentKey: `${input.sourceDocumentKey}:${contentSha256}`,
      title: input.name,
      mediaType: file.mediaType,
      contentSha256,
      extractedText: input.content,
      metadata: documentMetadata,
    });

    if (!createdDocument) {
      throw new IngestionPipelineError(
        "Source not found in this project",
        404,
        "source_not_found",
      );
    }

    const existing = createdDocument.document;

    if (existing.status === "archived") {
      throw new IngestionPipelineError(
        "Archived documents cannot be re-indexed",
        409,
        "document_archived",
      );
    }

    if (existing.status === "indexed") {
      return toResult(existing, {
        name: input.name,
        deduplicated: true,
      });
    }

    if (existing.status === "processing") {
      return toResult(existing, {
        name: input.name,
        deduplicated: true,
      });
    }

    const claim = await documents.claimForProcessing(
      projectId,
      existing.id,
    );

    if (!claim) {
      throw new IngestionPipelineError(
        "Document not found",
        404,
        "document_not_found",
      );
    }

    if (!claim.claimed) {
      return toResult(claim.document, {
        name: input.name,
        deduplicated: true,
      });
    }

    return processDocument({
      projectId,
      sourceId: existing.sourceId,
      documentId: existing.id,
      content: input.content,
      name: input.name,
      metadata: documentMetadata,
      deduplicated: !createdDocument.created,
    });
  }

  async function processDocument(input: {
    projectId: string;
    sourceId: string;
    documentId: string;
    content: string;
    name: string;
    metadata: Record<string, unknown>;
    deduplicated: boolean;
  }): Promise<IngestionResult> {
    const documents = stores.documents;
    const chunks = stores.chunks;
    const sources = stores.sources;

    if (!documents || !chunks || !sources) {
      throw new IngestionPipelineError(
        "Persistence unavailable",
        503,
        "persistence_unavailable",
      );
    }

    let chunksCreated = 0;
    let embeddingsCreated = 0;
    let model: string | null = null;

    try {
      const file = validateIngestionFile(input.name, input.content);
      const fileChunks = chunkTechnicalText(input.content, file.strategy);

      if (fileChunks.length === 0) {
        throw new IngestionPipelineError(
          "No indexable text was found in the document",
          400,
          "empty_document",
        );
      }

      for (const chunk of fileChunks) {
        const created = await chunks.createOrGetForDocument(
          input.projectId,
          input.documentId,
          {
            ordinal: chunk.ordinal,
            content: chunk.content,
            startOffset: chunk.startOffset,
            endOffset: chunk.endOffset,
            metadata: {
              format: file.extension || "dotfile",
              strategy: file.strategy,
              ...(typeof input.metadata.incidentId === "string"
                ? { incidentId: input.metadata.incidentId }
                : {}),
              ...(input.metadata.synthetic === true
                ? { synthetic: true }
                : {}),
              ...(typeof input.metadata.dataset === "string"
                ? { dataset: input.metadata.dataset }
                : {}),
            },
          },
        );

        if (!created) {
          throw new IngestionPipelineError(
            "Document not found",
            404,
            "document_not_found",
          );
        }

        if (created.created) {
          chunksCreated += 1;
        }
      }

      for (let batchNumber = 0; batchNumber < 100; batchNumber += 1) {
        const pending = await chunks.listWithoutEmbeddingsForDocument(
          input.projectId,
          input.documentId,
          EMBEDDING_BATCH_SIZE + 1,
        );

        if (pending === null) {
          throw new IngestionPipelineError(
            "Document not found",
            404,
            "document_not_found",
          );
        }

        const batch = pending.slice(0, EMBEDDING_BATCH_SIZE);
        if (batch.length === 0) {
          break;
        }

        const result = await requestEmbeddings(
          batch.map((chunk) => chunk.content),
          options,
        );

        if (!result.ok) {
          const errorCode =
            result.kind === "invalid"
              ? "invalid_embedding_response"
              : result.kind === "timeout"
                ? "embedding_service_timeout"
                : "embedding_service_unavailable";
          throw new IngestionPipelineError(
            result.kind === "invalid"
              ? "Embedding service returned an invalid response"
              : result.kind === "timeout"
                ? "Embedding service request timed out"
                : "Embedding service unavailable",
            result.kind === "invalid"
              ? 502
              : result.kind === "timeout"
                ? 504
                : 503,
            errorCode,
          );
        }

        const embeddingInputs: ChunkEmbeddingInput[] = batch.map(
          (chunk, index) => ({
            id: chunk.id,
            embedding: result.vectors[index]!,
            model: result.model,
          }),
        );
        const saved = await chunks.saveEmbeddingsForDocument(
          input.projectId,
          input.documentId,
          embeddingInputs,
        );

        if (saved === null || saved !== batch.length) {
          throw new IngestionPipelineError(
            saved === null ? "Document not found" : "Embedding indexing did not make progress; retry the document",
            saved === null ? 404 : 409,
            saved === null ? "document_not_found" : "embedding_indexing_conflict",
          );
        }

        embeddingsCreated += saved;
        model = result.model;

        if (pending.length <= EMBEDDING_BATCH_SIZE) {
          break;
        }

        if (batchNumber === 99) {
          throw new IngestionPipelineError(
            "Document exceeds the embedding batch limit",
            413,
            "too_many_chunks",
          );
        }
      }

      const metadata = isRecord(input.metadata) ? input.metadata : {};
      const ingestionMetadata = isRecord(metadata.ingestion)
        ? metadata.ingestion
        : {};
      const updatedSource = await sources.activateIfEnabled(
        input.projectId,
        input.sourceId,
      );

      if (!updatedSource) {
        throw new IngestionPipelineError(
          "The source was disabled during document ingestion",
          409,
          "source_disabled",
        );
      }

      const updated = await documents.setIngestionState(
        input.projectId,
        input.documentId,
        {
          status: "indexed",
          completedAt: new Date().toISOString(),
          chunks: fileChunks.length,
          embeddingModel:
            model ??
            (typeof ingestionMetadata.embeddingModel === "string"
              ? ingestionMetadata.embeddingModel
              : null),
          error: null,
        },
      );

      if (!updated) {
        throw new IngestionPipelineError(
          "Document not found",
          404,
          "document_not_found",
        );
      }

      const indexed = await documents.getForIngestion(
        input.projectId,
        input.documentId,
      );

      if (!indexed) {
        throw new IngestionPipelineError(
          "Document not found",
          404,
          "document_not_found",
        );
      }

      return toResult(indexed, {
        name: input.name,
        deduplicated: input.deduplicated,
        chunksCreated,
        embeddingsCreated,
        model,
      });
    } catch (error: unknown) {
      const failure = getErrorResponse(error);
      const errorCode =
        error instanceof IngestionPipelineError
          ? error.code
          : error instanceof ChunkContentConflictError
            ? "chunk_content_conflict"
            : "ingestion_processing_failed";

      try {
        await documents.setIngestionState(
          input.projectId,
          input.documentId,
          {
            status: "failed",
            completedAt: new Date().toISOString(),
            error: errorCode,
          },
        );
      } catch (stateError: unknown) {
        app.log.error(
          {
            err: stateError,
            projectId: input.projectId,
            documentId: input.documentId,
          },
          "Failed to persist document ingestion error state",
        );
      }

      app.log.error(
        { err: error, projectId: input.projectId, documentId: input.documentId },
        "Document ingestion failed",
      );
      throw new IngestionPipelineError(
        failure.message,
        failure.statusCode,
        errorCode,
      );
    }
  }

  async function ingestUploadedFile(
    projectId: string,
    file: UploadRequest,
  ): Promise<IngestionResult> {
    const validated = validateIngestionFile(file.name, file.content);

    return ingest(projectId, {
      content: file.content,
      name: validated.name,
      sourceDocumentKey: validated.name,
      metadata: {
        sourceType: "file_upload",
        sourceMetadata: {
          name: "Uploaded technical files",
          locator: "upload://",
          metadata: { ingestion: "web_upload" },
        },
        documentMetadata: {
          ingestion: {
            source: "web_upload",
          },
        },
      },
    });
  }

  async function retryDocument(
    projectId: string,
    documentId: string,
  ): Promise<IngestionResult> {
    const documents = stores.documents;
    if (!documents) {
      throw new IngestionPipelineError(
        "Persistence unavailable",
        503,
        "persistence_unavailable",
      );
    }

    const document = await documents.getForIngestion(
      projectId,
      documentId,
    );

    if (!document) {
      throw new IngestionPipelineError(
        "Document not found",
        404,
        "document_not_found",
      );
    }

    if (document.status === "archived") {
      throw new IngestionPipelineError(
        "Archived documents cannot be retried",
        409,
        "document_archived",
      );
    }

    if (document.status === "indexed") {
      return toResult(document, {
        name: document.title,
        deduplicated: true,
      });
    }

    if (!document.extractedText) {
      throw new IngestionPipelineError(
        "The original text is unavailable; upload the file again",
        409,
        "document_content_unavailable",
      );
    }

    const sources = stores.sources;
    if (!sources) {
      throw new IngestionPipelineError(
        "Persistence unavailable",
        503,
        "persistence_unavailable",
      );
    }

    const source = await sources.getForProject(
      projectId,
      document.sourceId,
    );

    if (!source) {
      throw new IngestionPipelineError(
        "Source not found in this project",
        404,
        "source_not_found",
      );
    }

    if (source.status === "disabled") {
      throw new IngestionPipelineError(
        "Disabled sources cannot be retried",
        409,
        "source_disabled",
      );
    }

    const claim = await documents.claimForProcessing(
      projectId,
      documentId,
    );

    if (!claim) {
      throw new IngestionPipelineError(
        "Document not found",
        404,
        "document_not_found",
      );
    }

    if (!claim.claimed) {
      return toResult(claim.document, {
        name: document.title,
        deduplicated: true,
      });
    }

    const sourceId = document.sourceId;

    return processDocument({
      projectId,
      sourceId,
      documentId,
      content: document.extractedText,
      name: document.title,
      metadata: document.metadata,
      deduplicated: true,
    });
  }

  app.post<{
    Params: { projectId: string };
    Body: UploadRequest;
    Reply: { data: IngestionResult } | ApiError;
  }>(
    "/api/projects/:projectId/ingestions",
    {
      schema: {
        params: {
          type: "object",
          properties: { projectId: uuidSchema },
          required: ["projectId"],
          additionalProperties: false,
        },
        body: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 255 },
            content: {
              type: "string",
              minLength: 1,
              maxLength: MAX_INGESTION_FILE_CHARS,
            },
          },
          required: ["name", "content"],
          additionalProperties: false,
        },
        response: {
          200: uploadResponseSchema,
          202: acceptedUploadResponseSchema,
          400: apiErrorSchema,
          404: apiErrorSchema,
          409: apiErrorSchema,
          413: apiErrorSchema,
          415: apiErrorSchema,
          502: apiErrorSchema,
          503: apiErrorSchema,
          504: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!isUploadRequest(request.body)) {
        return reply.code(400).send({ error: "Invalid upload request" });
      }

      try {
        const data = await ingestUploadedFile(
          request.params.projectId,
          request.body,
        );
        return reply.code(data.status === "indexed" ? 200 : 202).send({ data });
      } catch (error: unknown) {
        const failure = getErrorResponse(error);
        return reply
          .code(failure.statusCode)
          .send({ error: failure.message });
      }
    },
  );

  app.post<{
    Params: { projectId: string };
    Reply: {
      data: { dataset: string; files: IngestionResult[] };
    } | ApiError;
  }>(
    "/api/projects/:projectId/ingestions/demo",
    {
      schema: {
        params: {
          type: "object",
          properties: { projectId: uuidSchema },
          required: ["projectId"],
          additionalProperties: false,
        },
        response: {
          200: demoResponseSchema,
          202: acceptedDemoResponseSchema,
          404: apiErrorSchema,
          409: apiErrorSchema,
          413: apiErrorSchema,
          415: apiErrorSchema,
          502: apiErrorSchema,
          503: apiErrorSchema,
          504: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const readDemoFile =
        options.readDemoFile ?? readDemoFileFromRepository;
      const files: IngestionResult[] = [];

      try {
        const incidentStore = stores.incidents;
        if (!incidentStore) {
          throw new IngestionPipelineError(
            "Persistence unavailable",
            503,
            "persistence_unavailable",
          );
        }

        const incident = await incidentStore.ensureIncident(
          request.params.projectId,
          {
            externalReference: "INC-001",
            title: "Fallo de creación de pedidos (INC-001)",
            description:
              "Incidente sintético de demostración asociado a saturación observada del pool de conexiones.",
            serviceName: "pedidos-api",
            severity: "high",
            context: {
              dataset: DEMO_DATASET_ID,
              synthetic: true,
            },
          },
        );

        if (!incident) {
          throw new IngestionPipelineError(
            "Project not found",
            404,
            "project_not_found",
          );
        }

        for (const demoFile of DEMO_FILES) {
          const content = await readDemoFile(demoFile.path);

          files.push(
            await ingest(request.params.projectId, {
              content,
              name: demoFile.name,
              sourceDocumentKey: demoFile.path,
              metadata: {
                sourceType: "log_bundle",
                sourceMetadata: {
                  name: "INC-001 · dataset sintético",
                  locator: DEMO_SOURCE_LOCATOR,
                  metadata: {
                    dataset: DEMO_DATASET_ID,
                    synthetic: true,
                  },
                },
                documentMetadata: {
                  dataset: DEMO_DATASET_ID,
                  incidentId: "INC-001",
                  synthetic: true,
                  ingestion: {
                    source: "demo_import",
                  },
                },
                dataset: DEMO_DATASET_ID,
                incidentId: "INC-001",
                synthetic: true,
              },
            }),
          );
        }

        const statusCode = files.every((file) => file.status === "indexed")
          ? 200
          : 202;
        return reply.code(statusCode).send({
          data: { dataset: DEMO_DATASET_ID, files },
        });
      } catch (error: unknown) {
        const failure = getErrorResponse(error);
        return reply
          .code(failure.statusCode)
          .send({ error: failure.message });
      }
    },
  );

  app.post<{
    Params: { projectId: string; documentId: string };
    Reply: { data: IngestionResult } | ApiError;
  }>(
    "/api/projects/:projectId/documents/:documentId/retry",
    {
      schema: {
        params: {
          type: "object",
          properties: {
            projectId: uuidSchema,
            documentId: uuidSchema,
          },
          required: ["projectId", "documentId"],
          additionalProperties: false,
        },
        response: {
          200: uploadResponseSchema,
          202: acceptedUploadResponseSchema,
          404: apiErrorSchema,
          409: apiErrorSchema,
          413: apiErrorSchema,
          415: apiErrorSchema,
          502: apiErrorSchema,
          503: apiErrorSchema,
          504: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const data = await retryDocument(
          request.params.projectId,
          request.params.documentId,
        );
        return reply.code(data.status === "indexed" ? 200 : 202).send({ data });
      } catch (error: unknown) {
        const failure = getErrorResponse(error);
        return reply
          .code(failure.statusCode)
          .send({ error: failure.message });
      }
    },
  );
}
