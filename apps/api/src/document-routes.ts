
import type { FastifyInstance } from "fastify";

import type {
  CreateDocumentInput,
  DocumentRecord,
} from "./document-repository.js";

interface DocumentStore {
  listForProject(
    projectId: string,
  ): Promise<DocumentRecord[] | null>;

  createForProject(
    projectId: string,
    input: CreateDocumentInput,
  ): Promise<DocumentRecord | null>;
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

const documentSchema = {
  type: "object",
  properties: {
    id: uuidSchema,
    projectId: uuidSchema,
    sourceId: uuidSchema,
    sourceDocumentKey: {
      anyOf: [
        { type: "string" },
        { type: "null" },
      ],
    },
    title: { type: "string" },
    mediaType: {
      anyOf: [
        { type: "string" },
        { type: "null" },
      ],
    },
    contentSha256: {
      anyOf: [
        { type: "string", pattern: "^[0-9a-f]{64}$" },
        { type: "null" },
      ],
    },
    status: {
      type: "string",
      enum: [
        "discovered",
        "processing",
        "indexed",
        "failed",
        "archived",
      ],
    },
    metadata: {
      type: "object",
      additionalProperties: true,
    },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
  required: [
    "id",
    "projectId",
    "sourceId",
    "sourceDocumentKey",
    "title",
    "mediaType",
    "contentSha256",
    "status",
    "metadata",
    "createdAt",
    "updatedAt",
  ],
  additionalProperties: false,
} as const;

const documentListSchema = {
  type: "object",
  properties: {
    data: {
      type: "array",
      items: documentSchema,
    },
  },
  required: ["data"],
  additionalProperties: false,
} as const;

const documentDataSchema = {
  type: "object",
  properties: {
    data: documentSchema,
  },
  required: ["data"],
  additionalProperties: false,
} as const;

const createDocumentSchema = {
  type: "object",
  properties: {
    sourceId: uuidSchema,
    sourceDocumentKey: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: 512, pattern: "\\S" },
        { type: "null" },
      ],
    },
    title: {
      type: "string",
      minLength: 1,
      maxLength: 500,
      pattern: "\\S",
    },
    mediaType: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: 255, pattern: "\\S" },
        { type: "null" },
      ],
    },
    contentSha256: {
      anyOf: [
        { type: "string", pattern: "^[0-9a-f]{64}$" },
        { type: "null" },
      ],
    },
    extractedText: {
      anyOf: [
        { type: "string", maxLength: 200000 },
        { type: "null" },
      ],
    },
    metadata: {
      type: "object",
      additionalProperties: true,
    },
  },
  required: ["sourceId", "title"],
  additionalProperties: false,
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

export function registerDocumentRoutes(
  app: FastifyInstance,
  store?: DocumentStore,
): void {
  app.get<{
    Params: { projectId: string };
    Reply: { data: DocumentRecord[] } | ApiError;
  }>(
    "/api/projects/:projectId/documents",
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
        response: {
          200: documentListSchema,
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
        const data = await store.listForProject(
          request.params.projectId,
        );

        if (data === null) {
          return reply.code(404).send({
            error: "Project not found",
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
    Params: { projectId: string };
    Body: CreateDocumentInput;
    Reply: { data: DocumentRecord } | ApiError;
  }>(
    "/api/projects/:projectId/documents",
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
        body: createDocumentSchema,
        response: {
          201: documentDataSchema,
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

      try {
        const data = await store.createForProject(
          request.params.projectId,
          request.body,
        );

        if (data === null) {
          return reply.code(404).send({
            error: "Project or source not found in this project",
          });
        }

        return reply.code(201).send({ data });
      } catch (error: unknown) {
        if (isPostgresErrorCode(error, "23505")) {
          return reply.code(409).send({
            error: "Document key already exists for this source",
          });
        }

        return reply.code(503).send({
          error: "Persistence unavailable",
        });
      }
    },
  );
}
