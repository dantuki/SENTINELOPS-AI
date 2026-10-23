
import type { FastifyInstance } from "fastify";

import type {
  CreateDocumentChunkInput,
  DocumentChunkRecord,
} from "./chunk-repository.js";

interface ChunkStore {
  listForDocument(
    projectId: string,
    documentId: string,
  ): Promise<DocumentChunkRecord[] | null>;

  createForDocument(
    projectId: string,
    documentId: string,
    input: CreateDocumentChunkInput,
  ): Promise<DocumentChunkRecord | null>;
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

const nullableNonNegativeIntegerSchema = {
  anyOf: [
    { type: "integer", minimum: 0 },
    { type: "null" },
  ],
} as const;

const chunkSchema = {
  type: "object",
  properties: {
    id: uuidSchema,
    projectId: uuidSchema,
    documentId: uuidSchema,
    ordinal: { type: "integer", minimum: 0 },
    content: { type: "string" },
    tokenCount: nullableNonNegativeIntegerSchema,
    startOffset: nullableNonNegativeIntegerSchema,
    endOffset: nullableNonNegativeIntegerSchema,
    metadata: {
      type: "object",
      additionalProperties: true,
    },
    createdAt: { type: "string", format: "date-time" },
  },
  required: [
    "id",
    "projectId",
    "documentId",
    "ordinal",
    "content",
    "tokenCount",
    "startOffset",
    "endOffset",
    "metadata",
    "createdAt",
  ],
  additionalProperties: false,
} as const;

const chunkListSchema = {
  type: "object",
  properties: {
    data: {
      type: "array",
      items: chunkSchema,
    },
  },
  required: ["data"],
  additionalProperties: false,
} as const;

const chunkDataSchema = {
  type: "object",
  properties: {
    data: chunkSchema,
  },
  required: ["data"],
  additionalProperties: false,
} as const;

const createChunkSchema = {
  type: "object",
  properties: {
    ordinal: {
      type: "integer",
      minimum: 0,
    },
    content: {
      type: "string",
      minLength: 1,
      maxLength: 20000,
      pattern: "\\S",
    },
    tokenCount: nullableNonNegativeIntegerSchema,
    startOffset: {
      anyOf: [
        { type: "integer", minimum: 0 },
        { type: "null" },
      ],
    },
    endOffset: {
      anyOf: [
        { type: "integer", minimum: 0 },
        { type: "null" },
      ],
    },
    metadata: {
      type: "object",
      additionalProperties: true,
    },
  },
  required: ["ordinal", "content"],
  additionalProperties: false,
  anyOf: [
    {
      not: {
        anyOf: [
          { required: ["startOffset"] },
          { required: ["endOffset"] },
        ],
      },
    },
    {
      required: ["startOffset", "endOffset"],
      properties: {
        startOffset: { type: "null" },
        endOffset: { type: "null" },
      },
    },
    {
      required: ["startOffset", "endOffset"],
      properties: {
        startOffset: { type: "integer", minimum: 0 },
        endOffset: { type: "integer", minimum: 0 },
      },
    },
  ],
} as const;

function isPostgresErrorCode(
  error: unknown,
  expectedCode: string,
): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === expectedCode
  );
}

export function registerChunkRoutes(
  app: FastifyInstance,
  store?: ChunkStore,
): void {
  app.get<{
    Params: {
      projectId: string;
      documentId: string;
    };
    Reply: { data: DocumentChunkRecord[] } | ApiError;
  }>(
    "/api/projects/:projectId/documents/:documentId/chunks",
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
          200: chunkListSchema,
          404: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!store) {
        return reply.code(503).send({
          error: "Persistence unavailable",
        });
      }

      try {
        const data = await store.listForDocument(
          request.params.projectId,
          request.params.documentId,
        );

        if (data === null) {
          return reply.code(404).send({
            error: "Document not found in this project",
          });
        }

        return reply.code(200).send({ data });
      } catch {
        return reply.code(503).send({
          error: "Persistence unavailable",
        });
      }
    },
  );

  app.post<{
    Params: {
      projectId: string;
      documentId: string;
    };
    Body: CreateDocumentChunkInput;
    Reply: { data: DocumentChunkRecord } | ApiError;
  }>(
    "/api/projects/:projectId/documents/:documentId/chunks",
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
        body: createChunkSchema,
        response: {
          201: chunkDataSchema,
          400: apiErrorSchema,
          404: apiErrorSchema,
          409: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!store) {
        return reply.code(503).send({
          error: "Persistence unavailable",
        });
      }

      const { startOffset, endOffset } = request.body;

      if (
        startOffset != null &&
        endOffset != null &&
        endOffset <= startOffset
      ) {
        return reply.code(400).send({
          error: "endOffset must be greater than startOffset",
        });
      }

      try {
        const data = await store.createForDocument(
          request.params.projectId,
          request.params.documentId,
          request.body,
        );

        if (data === null) {
          return reply.code(404).send({
            error: "Document not found in this project",
          });
        }

        return reply.code(201).send({ data });
      } catch (error: unknown) {
        if (isPostgresErrorCode(error, "23505")) {
          return reply.code(409).send({
            error: "Chunk ordinal already exists for this document",
          });
        }

        return reply.code(503).send({
          error: "Persistence unavailable",
        });
      }
    },
  );
}
