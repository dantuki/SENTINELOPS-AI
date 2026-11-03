
import type { FastifyInstance } from "fastify";

import {
  requestEmbeddings,
  type EmbeddingClientOptions,
} from "./embedding-client.js";
import {
  EmbeddingWriteConflictError,
  type ChunkEmbeddingInput,
  type PendingEmbeddingChunk,
  type SemanticSearchChunkRecord,
} from "./chunk-repository.js";

const EMBEDDING_BATCH_SIZE = 32;
const MAX_TEXT_CHARS = 20000;
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 20;

interface EmbeddingStore {
  projectExists(projectId: string): Promise<boolean>;

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

  searchSimilarChunks(
    projectId: string,
    embedding: number[],
    limit?: number,
  ): Promise<SemanticSearchChunkRecord[] | null>;
}

interface ApiError {
  error: string;
}

const apiErrorSchema = {
  type: "object",
  properties: {
    error: { type: "string" },
  },
  required: ["error"],
  additionalProperties: false,
} as const;

const uuidSchema = {
  type: "string",
  format: "uuid",
} as const;

const embeddingBatchResponseSchema = {
  type: "object",
  properties: {
    data: {
      type: "object",
      properties: {
        processed: { type: "integer", minimum: 0 },
        model: {
          anyOf: [{ type: "string" }, { type: "null" }],
        },
        hasMore: { type: "boolean" },
      },
      required: ["processed", "model", "hasMore"],
      additionalProperties: false,
    },
  },
  required: ["data"],
  additionalProperties: false,
} as const;

const semanticSearchResponseSchema = {
  type: "object",
  properties: {
    data: {
      type: "object",
      properties: {
        model: { type: "string" },
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: uuidSchema,
              projectId: uuidSchema,
              documentId: uuidSchema,
              ordinal: { type: "integer", minimum: 0 },
              content: { type: "string" },
              score: { type: "number" },
            },
            required: [
              "id",
              "projectId",
              "documentId",
              "ordinal",
              "content",
              "score",
            ],
            additionalProperties: false,
          },
        },
      },
      required: ["model", "results"],
      additionalProperties: false,
    },
  },
  required: ["data"],
  additionalProperties: false,
} as const;

export function registerEmbeddingRoutes(
  app: FastifyInstance,
  store?: EmbeddingStore,
  options: EmbeddingClientOptions = {},
): void {
  app.post<{
    Params: {
      projectId: string;
      documentId: string;
    };
    Reply:
      | {
          data: {
            processed: number;
            model: string | null;
            hasMore: boolean;
          };
        }
      | ApiError;
  }>(
    "/api/projects/:projectId/documents/:documentId/embeddings",
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
          200: embeddingBatchResponseSchema,
          404: apiErrorSchema,
          409: apiErrorSchema,
          502: apiErrorSchema,
          503: apiErrorSchema,
          504: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!store) {
        return reply.code(503).send({
          error: "Persistence unavailable",
        });
      }

      const { projectId, documentId } = request.params;

      let pending: PendingEmbeddingChunk[] | null;

      try {
        pending = await store.listWithoutEmbeddingsForDocument(
          projectId,
          documentId,
          EMBEDDING_BATCH_SIZE + 1,
        );
      } catch {
        return reply.code(503).send({
          error: "Persistence unavailable",
        });
      }

      if (pending === null) {
        return reply.code(404).send({
          error: "Document not found in this project",
        });
      }

      const batch = pending.slice(0, EMBEDDING_BATCH_SIZE);

      if (batch.length === 0) {
        return reply.code(200).send({
          data: {
            processed: 0,
            model: null,
            hasMore: false,
          },
        });
      }

      const providerResult = await requestEmbeddings(
        batch.map((chunk) => chunk.content),
        options,
      );

      if (!providerResult.ok) {
        if (providerResult.kind === "invalid") {
          return reply.code(502).send({
            error: "Invalid embedding response",
          });
        }

        if (providerResult.kind === "timeout") {
          return reply.code(504).send({
            error: "Embedding request timed out",
          });
        }

        return reply.code(503).send({
          error: "Embedding service unavailable",
        });
      }

      const embeddingInputs: ChunkEmbeddingInput[] = batch.map(
        (chunk, index) => ({
          id: chunk.id,
          embedding: providerResult.vectors[index]!,
          model: providerResult.model,
        }),
      );

      let saved: number | null;

      try {
        saved = await store.saveEmbeddingsForDocument(
          projectId,
          documentId,
          embeddingInputs,
        );
      } catch (error: unknown) {
        if (error instanceof EmbeddingWriteConflictError) {
          return reply.code(409).send({
            error: "A chunk changed while embeddings were generated",
          });
        }

        return reply.code(503).send({
          error: "Persistence unavailable",
        });
      }

      if (saved === null) {
        return reply.code(404).send({
          error: "Document not found in this project",
        });
      }

      return reply.code(200).send({
        data: {
          processed: saved,
          model: providerResult.model,
          hasMore: pending.length > EMBEDDING_BATCH_SIZE,
        },
      });
    },
  );

  app.post<{
    Params: {
      projectId: string;
    };
    Body: {
      query: string;
      limit?: number;
    };
    Reply:
      | {
          data: {
            model: string;
            results: SemanticSearchChunkRecord[];
          };
        }
      | ApiError;
  }>(
    "/api/projects/:projectId/search",
    {
      schema: {
        params: {
          type: "object",
          properties: {
            projectId: uuidSchema,
          },
          required: ["projectId"],
          additionalProperties: false,
        },
        body: {
          type: "object",
          properties: {
            query: {
              type: "string",
              minLength: 1,
              maxLength: MAX_TEXT_CHARS,
              pattern: "\\S",
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: MAX_SEARCH_LIMIT,
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
        response: {
          200: semanticSearchResponseSchema,
          400: apiErrorSchema,
          404: apiErrorSchema,
          502: apiErrorSchema,
          503: apiErrorSchema,
          504: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!store) {
        return reply.code(503).send({
          error: "Persistence unavailable",
        });
      }

      const { projectId } = request.params;

      let projectExists: boolean;

      try {
        projectExists = await store.projectExists(projectId);
      } catch {
        return reply.code(503).send({
          error: "Persistence unavailable",
        });
      }

      if (!projectExists) {
        return reply.code(404).send({
          error: "Project not found",
        });
      }

      const providerResult = await requestEmbeddings(
        [request.body.query],
        options,
      );

      if (!providerResult.ok) {
        if (providerResult.kind === "invalid") {
          return reply.code(502).send({
            error: "Invalid embedding response",
          });
        }

        if (providerResult.kind === "timeout") {
          return reply.code(504).send({
            error: "Embedding request timed out",
          });
        }

        return reply.code(503).send({
          error: "Embedding service unavailable",
        });
      }

      let results: SemanticSearchChunkRecord[] | null;

      try {
        results = await store.searchSimilarChunks(
          projectId,
          providerResult.vectors[0]!,
          request.body.limit ?? DEFAULT_SEARCH_LIMIT,
        );
      } catch {
        return reply.code(503).send({
          error: "Persistence unavailable",
        });
      }

      if (results === null) {
        return reply.code(404).send({
          error: "Project not found",
        });
      }

      return reply.code(200).send({
        data: {
          model: providerResult.model,
          results,
        },
      });
    },
  );
}
